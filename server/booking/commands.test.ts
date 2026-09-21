import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  aiAgents, appointments, automationEvents, bookingCommands, bookingReservations,
  contacts, messages, services, workspaces,
} from "@/db/schema";
import { getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { openBookingDraft, patchBookingDraft, type BookingContext } from "./drafts";
import {
  prepareBookingPreview, recordBookingPreviewDelivery,
  searchBookingAvailability, selectBookingOffer,
} from "./offers";
import { confirmAndExecuteBooking, confirmBookingPreview, getBookingOutcome } from "./commands";
import { recoverBookingCommands } from "./execution";

const now = new Date("2030-09-21T12:00:00.000Z");
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds);

describe("durable native appointment command (disposable PostgreSQL)", () => {
  let workspaceId: string, contactId: string, conversationId: string, serviceId: string;
  let context: BookingContext;

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Native booking transaction" }).returning();
    workspaceId = workspace.id;
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Ada" }).returning();
    contactId = contact.id;
    const [service] = await db.insert(services).values({
      workspaceId, name: "Office Cleaning", durationMinutes: 240,
    }).returning();
    serviceId = service.id;
    await db.insert(aiAgents).values({ workspaceId, name: "Mia", status: "ACTIVE" });
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
    context = { workspaceId, contactId, conversationId, channel: "WEBCHAT", sessionKey: "widget-A" };
    await saveBusinessSetup(workspaceId, {
      businessName: "Office Cleaning", timezone: "Africa/Lagos", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "19:00",
      })),
    });
  });
  afterAll(async () => closeDatabase());

  async function previewFor(ctx = context) {
    const opened = await openBookingDraft(ctx, now);
    if (opened.state !== "OPENED") throw new Error("Expected new session");
    const patched = await patchBookingDraft(ctx, {
      draftId: opened.draft.id, expectedVersion: 1, sourceEventId: ctx.sessionKey + ":details",
      patch: { serviceId, localDate: "2030-09-23", localTime: "11:00",
        customerTimezone: "Africa/Lagos" },
    }, now);
    if (patched.state !== "UPDATED") throw new Error("Expected updated draft");
    const slots = await searchBookingAvailability(ctx, {
      draftId: opened.draft.id, expectedVersion: patched.draft.version,
    }, now);
    if (slots.state !== "SLOTS_AVAILABLE") throw new Error("Expected a real native slot");
    const selected = await selectBookingOffer(ctx, {
      draftId: opened.draft.id, expectedVersion: patched.draft.version,
      offerId: slots.offers[0].id,
    }, now);
    const preview = await prepareBookingPreview(ctx, {
      draftId: opened.draft.id, expectedVersion: selected.draft.version,
    }, now);
    const [outbound] = await db.insert(messages).values({
      workspaceId, conversationId: ctx.conversationId!,
      channel: "WEBCHAT", direction: "OUTBOUND", senderType: "AI",
      contentType: "TEXT", body: "Office Cleaning Sep 23, 11 AM–3 PM Lagos. Shall I book it?",
      metadata: { bookingPreviewId: preview.preview.id,
        bookingDraftId: opened.draft.id, bookingVersion: selected.draft.version },
      createdAt: later(1000),
    }).returning();
    await recordBookingPreviewDelivery(ctx, {
      draftId: opened.draft.id, expectedVersion: selected.draft.version,
      previewId: preview.preview.id, deliveryChannel: "WEBCHAT",
      deliveryReference: outbound.id,
    }, later(1000));
    return { draftId: opened.draft.id, version: selected.draft.version,
      previewId: preview.preview.id };
  }

  async function confirmMessage(text = "Yes, please.", ctx = context) {
    const [message] = await db.insert(messages).values({
      workspaceId, conversationId: ctx.conversationId!,
      channel: "WEBCHAT", direction: "INBOUND", senderType: "CUSTOMER",
      contentType: "TEXT", body: text, createdAt: later(2000),
    }).returning();
    return message.id;
  }

  it("persists the exact 240-minute appointment once with a matching durable receipt and event", async () => {
    const preview = await previewFor();
    const sourceEventId = await confirmMessage();
    const result = await confirmAndExecuteBooking(context, {
      ...preview, expectedVersion: preview.version, sourceEventId,
    }, later(2000));
    expect(result.state).toBe("CONFIRMED");
    const stored = await db.select().from(appointments);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "CONFIRMED", serviceId,
      startsAt: new Date("2030-09-23T10:00:00.000Z"),
      endsAt: new Date("2030-09-23T14:00:00.000Z"),
    });
    const command = (await db.select().from(bookingCommands))[0];
    expect(command).toMatchObject({ state: "CONFIRMED", appointmentId: stored[0].id });
    expect(stored[0].bookingCommandId).toBe(command.id);
    const outcome = await getBookingOutcome(context, preview.draftId);
    expect(outcome.state).toBe("CONFIRMED");
    expect(outcome.appointment?.id).toBe(stored[0].id);
    expect((await db.select().from(automationEvents).where(eq(
      automationEvents.type, "APPOINTMENT_CONFIRMED",
    )))).toHaveLength(1);
    expect((await db.select().from(bookingReservations))[0].state).toBe("RELEASED");
  });

  it("returns the original appointment for duplicated confirmation events", async () => {
    const preview = await previewFor();
    const sourceEventId = await confirmMessage();
    const input = { ...preview, expectedVersion: preview.version, sourceEventId };
    const [first, second] = await Promise.all([
      confirmAndExecuteBooking(context, input, later(2000)),
      confirmAndExecuteBooking(context, input, later(2000)),
    ]);
    expect(["CONFIRMED", "COMMITTING", "PENDING"]).toContain(first.state);
    expect(["CONFIRMED", "COMMITTING", "PENDING"]).toContain(second.state);
    expect(await db.select().from(bookingCommands)).toHaveLength(1);
    expect(await db.select().from(appointments)).toHaveLength(1);
    expect((await getBookingOutcome(context, preview.draftId)).state).toBe("CONFIRMED");
  });

  it("does not let 'yes, but noon' approve the old preview", async () => {
    const preview = await previewFor();
    const sourceEventId = await confirmMessage("Yes, but make it noon.");
    await expect(confirmAndExecuteBooking(context, {
      ...preview, expectedVersion: preview.version, sourceEventId,
    }, later(2000))).rejects.toMatchObject({ code: "BOOKING_CONFIRMATION_REQUIRED" });
    expect(await db.select().from(bookingCommands)).toHaveLength(0);
    expect(await db.select().from(appointments)).toHaveLength(0);
  });

  it("prevents two customers from reserving the same one-capacity interval", async () => {
    const first = await previewFor();
    const [other] = await db.insert(contacts).values({ workspaceId, name: "Second caller" }).returning();
    const secondContext: BookingContext = {
      ...context, contactId: other.id, sessionKey: "widget-B",
      conversationId: (await getOrCreateOpenConversation(workspaceId, other.id)).id,
    };
    const second = await previewFor(secondContext);
    const one = await confirmMessage("Yes.", context);
    const two = await confirmMessage("Yes.", secondContext);
    const results = await Promise.allSettled([
      confirmAndExecuteBooking(context, {
        ...first, expectedVersion: first.version, sourceEventId: one,
      }, later(2000)),
      confirmAndExecuteBooking(secondContext, {
        ...second, expectedVersion: second.version, sourceEventId: two,
      }, later(2000)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(bookingCommands)).toHaveLength(1);
    expect(await db.select().from(appointments)).toHaveLength(1);
  });

  it("rejects a booking if the agent capability was disabled after preview delivery", async () => {
    const preview = await previewFor();
    const sourceEventId = await confirmMessage();
    const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, workspaceId));
    await db.update(aiAgents).set({
      behaviorSettings: { capabilities: {
        ANSWER_INQUIRY: true, UPDATE_CONTACT: true, UPDATE_LEAD: true, QUALIFY_LEAD: true,
        CHECK_AVAILABILITY: true, BOOK_APPOINTMENT: false,
        RECORD_SMS_CONSENT: true, SEND_SMS: true, ESCALATE: true,
      } },
    }).where(eq(aiAgents.id, agent.id));
    await expect(confirmAndExecuteBooking(context, {
      ...preview, expectedVersion: preview.version, sourceEventId,
    }, later(2000))).rejects.toMatchObject({ code: "AGENT_ACTION_DISABLED" });
    expect(await db.select().from(appointments)).toHaveLength(0);
  });

  it("recovers a command persisted before dispatch after a process crash", async () => {
    const preview = await previewFor();
    const sourceEventId = await confirmMessage();
    const accepted = await confirmBookingPreview(context, {
      ...preview, expectedVersion: preview.version, sourceEventId,
    }, later(2000));
    expect(accepted.state).toBe("PENDING");
    expect(await db.select().from(appointments)).toHaveLength(0);

    const recovered = await recoverBookingCommands();
    expect(recovered.confirmed).toBe(1);
    expect(await db.select().from(appointments)).toHaveLength(1);
    expect((await db.select().from(bookingCommands))[0].state).toBe("CONFIRMED");
    expect((await db.select().from(bookingReservations))[0].state).toBe("RELEASED");
  });

  it("does not reissue an uncertain external create merely because an execution lease expired", async () => {
    const preview = await previewFor();
    const sourceEventId = await confirmMessage();
    const accepted = await confirmBookingPreview(context, {
      ...preview, expectedVersion: preview.version, sourceEventId,
    }, later(2000));
    const commandId = accepted.command.id;
    await db.update(bookingCommands).set({
      provider: "calendly",
      state: "COMMITTING",
      providerAttemptedAt: later(2100),
      leaseOwner: "abandoned-worker",
      leaseExpiresAt: new Date(now.getTime() - 1000),
      attemptCount: 1,
    }).where(eq(bookingCommands.id, commandId));

    const recovered = await recoverBookingCommands();
    expect(recovered.unresolved).toBe(1);
    const [command] = await db.select().from(bookingCommands).where(eq(bookingCommands.id, commandId));
    expect(command.state).toBe("RECONCILING");
    expect(command.attemptCount).toBe(1);
    expect((await db.select().from(appointments))).toHaveLength(0);
    expect((await db.select().from(bookingReservations))[0].state).toBe("ACTIVE");
  });
});

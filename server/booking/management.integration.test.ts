import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  aiAgents, appointmentManagementRequests, appointments, automationEvents,
  bookingDrafts, contacts, services, workspaces,
} from "@/db/schema";
import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import {
  appointmentManagementIntent, handleAppointmentManagementTurn,
  recordAppointmentManagementPreviewDelivery,
} from "./management";
import type { BookingContext } from "./drafts";

describe("existing appointment management (isolated from V2 booking)", () => {
  let ctx: BookingContext;
  let appointmentId = "";
  const oldStart = new Date("2037-09-23T10:00:00.000Z");
  const oldEnd = new Date("2037-09-23T14:00:00.000Z");

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Appointment management" }).returning();
    await db.insert(aiAgents).values({ workspaceId: workspace.id, name: "Mia", status: "ACTIVE" });
    const [contact] = await db.insert(contacts).values({ workspaceId: workspace.id, name: "Customer" }).returning();
    const conversation = await getOrCreateOpenConversation(workspace.id, contact.id);
    ctx = {
      workspaceId: workspace.id,
      contactId: contact.id,
      conversationId: conversation.id,
      sessionKey: "webchat-management-session",
      channel: "WEBCHAT",
    };
    await saveBusinessSetup(workspace.id, {
      businessName: "Cleaning", timezone: "UTC", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "18:00",
      })),
    });
    const [appointment] = await db.insert(appointments).values({
      workspaceId: workspace.id, contactId: contact.id,
      conversationId: conversation.id, title: "Office Cleaning",
      startsAt: oldStart, endsAt: oldEnd, timezone: "UTC",
      status: "CONFIRMED", bookingSource: "AI",
    }).returning();
    appointmentId = appointment.id;
  });

  afterAll(closeDatabase);
  afterEach(() => vi.restoreAllMocks());

  async function inbound(body: string) {
    return appendMessage(ctx.workspaceId, ctx.conversationId!, {
      channel: "WEBCHAT", direction: "INBOUND", senderType: "CUSTOMER",
      contentType: "TEXT", body, status: "RECEIVED", metadata: {},
    });
  }

  async function turn(body: string) {
    const message = await inbound(body);
    return handleAppointmentManagementTurn(ctx, {
      id: message.id, body,
    }, new Date("2030-09-21T12:00:00.000Z"));
  }

  async function delivered(requestId: string, text: string) {
    const reply = await appendMessage(ctx.workspaceId, ctx.conversationId!, {
      channel: "WEBCHAT", direction: "OUTBOUND", senderType: "AI",
      contentType: "TEXT", body: text, status: "DELIVERED", metadata: {},
    });
    await recordAppointmentManagementPreviewDelivery(ctx, requestId, reply.id,
      (await db.select().from(appointmentManagementRequests)
        .where(eq(appointmentManagementRequests.id, requestId)))[0].version,
    );
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  it("leaves unfinished V2 booking cancellation and approval with booking v2", async () => {
    await db.insert(bookingDrafts).values({
      workspaceId: ctx.workspaceId, contactId: ctx.contactId,
      conversationId: ctx.conversationId, channel: "WEBCHAT",
      sessionKey: ctx.sessionKey,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const cancelled = await turn("Cancel my appointment");
    expect(cancelled).toBeNull();
    const approval = await turn("Yes");
    expect(approval).toBeNull();
    expect(await db.select().from(appointmentManagementRequests)).toHaveLength(0);
    const [current] = await db.select().from(appointments);
    expect(current.id).toBe(appointmentId);
    expect(current.status).toBe("CONFIRMED");
  });

  it("does not let an expired collecting booking draft block appointment management", async () => {
    await db.insert(bookingDrafts).values({
      workspaceId: ctx.workspaceId, contactId: ctx.contactId,
      conversationId: ctx.conversationId, channel: "WEBCHAT",
      sessionKey: ctx.sessionKey,
      expiresAt: new Date("2029-09-21T12:00:00.000Z"),
    });
    const result = await turn("Please reschedule my existing appointment");
    expect(result?.reply).toContain("I found your existing Office Cleaning");
    expect(await db.select().from(appointmentManagementRequests)).toHaveLength(1);
    expect((await db.select().from(appointments))[0].status).toBe("CONFIRMED");
  });

  it("routes existing appointment updates without entering new booking", async () => {
    expect(appointmentManagementIntent("I'd like to update my appointment")).toBe("RESCHEDULE");
    expect(appointmentManagementIntent("I want to book a new appointment")).toBeNull();
    const started = await turn("I'd like to update my appointment");
    expect(started?.reply).toContain("I found your existing Office Cleaning");
    expect(started?.reply).toContain("What date would you like");
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
  });

  it("requires delivered readback and explicit confirmation to reschedule exactly one existing appointment", async () => {
    await turn("I'd like to update my appointment");
    const preview = await turn("September 24, 2037 at 10 AM");
    expect(preview?.reply).toContain("move your existing");
    expect(preview?.reply).toContain("No new appointment will be created");
    expect(preview?.preview).toBeDefined();
    let [saved] = await db.select().from(appointments);
    expect(saved.startsAt.toISOString()).toBe(oldStart.toISOString());

    // A confirmation in the same turn as the proposal is never sufficient.
    const early = await turn("Yes");
    expect(early?.reply).toContain("haven't delivered");
    expect((await db.select().from(appointments))[0].startsAt.toISOString())
      .toBe(oldStart.toISOString());

    await delivered(preview!.preview!.requestId, preview!.reply);
    const committed = await turn("Yes");
    expect(committed?.reply).toContain("rescheduled and confirmed");
    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(appointmentId);
    expect(rows[0].startsAt.toISOString()).toBe("2037-09-24T10:00:00.000Z");
    expect(rows[0].endsAt.toISOString()).toBe("2037-09-24T14:00:00.000Z");
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
    const events = await db.select().from(automationEvents)
      .where(eq(automationEvents.type, "APPOINTMENT_RESCHEDULED"));
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(appointmentId);

    const replay = await turn("Yes");
    expect(replay?.reply).toContain("No additional change was made");
    expect((await db.select().from(automationEvents)
      .where(eq(automationEvents.type, "APPOINTMENT_RESCHEDULED")))).toHaveLength(1);
  });

  it("recovers conversationally from invalid proposed times without creating appointments", async () => {
    await turn("Please reschedule my appointment");
    const invalid = await turn("September 24, 2037 at 25:99");
    expect(invalid?.reply).toContain("valid time");
    const [current] = await db.select().from(appointments);
    expect(current.startsAt.toISOString()).toBe(oldStart.toISOString());
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
  });

  it("cancels only after the customer receives and confirms the exact appointment preview", async () => {
    const preview = await turn("Please cancel my appointment");
    expect(preview?.reply).toContain("Please confirm: cancel your existing");
    expect((await db.select().from(appointments))[0].status).toBe("CONFIRMED");
    await delivered(preview!.preview!.requestId, preview!.reply);
    const denied = await turn("No");
    expect(denied?.reply).toContain("not been changed");
    expect((await db.select().from(appointments))[0].status).toBe("CONFIRMED");

    const again = await turn("Cancel my appointment");
    await delivered(again!.preview!.requestId, again!.reply);
    const committed = await turn("Yes");
    expect(committed?.reply).toContain("cancelled");
    expect((await db.select().from(appointments))[0].status).toBe("CANCELLED");
    expect((await db.select().from(automationEvents)
      .where(eq(automationEvents.type, "APPOINTMENT_CANCELLED")))).toHaveLength(1);
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
  });

  it("changes the existing native appointment's service and recalculates its duration", async () => {
    const [industrial] = await db.insert(services).values({
      workspaceId: ctx.workspaceId, name: "Industrial Cleaning",
      durationMinutes: 120, active: true,
    }).returning();
    await turn("I'd like to update my appointment");
    const chosen = await turn("Industrial Cleaning");
    expect(chosen?.reply).toContain("Industrial Cleaning");
    expect(chosen?.reply).toContain("What date");
    const preview = await turn("September 24, 2037 at 10 AM");
    expect(preview?.reply).toContain("Industrial Cleaning");
    expect(preview?.preview).toBeDefined();
    await delivered(preview!.preview!.requestId, preview!.reply);
    const committed = await turn("Yes");
    expect(committed?.reply).toContain("Industrial Cleaning");
    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(appointmentId);
    expect(rows[0].serviceId).toBe(industrial.id);
    expect(rows[0].title).toBe("Industrial Cleaning");
    expect(rows[0].startsAt.toISOString()).toBe("2037-09-24T10:00:00.000Z");
    expect(rows[0].endsAt.toISOString()).toBe("2037-09-24T12:00:00.000Z");
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
  });

  it("keeps the original slot only when requested during a service change", async () => {
    await db.insert(services).values({
      workspaceId: ctx.workspaceId, name: "Industrial Cleaning",
      durationMinutes: 120, active: true,
    });
    await turn("I want to change my appointment");
    await turn("Industrial Cleaning");
    const proposed = await turn("Keep the same date and time");
    expect(proposed?.reply).toContain("Industrial Cleaning");
    expect(proposed?.reply).toContain("Sep 23, 2037");
    expect(proposed?.preview).toBeDefined();
    await delivered(proposed!.preview!.requestId, proposed!.reply);
    expect((await turn("Yes"))?.reply).toContain("Industrial Cleaning");
    const [changed] = await db.select().from(appointments);
    expect(changed.id).toBe(appointmentId);
    expect(changed.startsAt.toISOString()).toBe(oldStart.toISOString());
    expect(changed.endsAt.toISOString()).toBe("2037-09-23T12:00:00.000Z");
  });

  it("refuses a stale proposal rather than overriding a staff change", async () => {
    await turn("I'd like to update my appointment");
    const preview = await turn("September 24, 2037 at 10 AM");
    await delivered(preview!.preview!.requestId, preview!.reply);
    const changed = new Date("2037-09-25T10:00:00.000Z");
    await db.update(appointments).set({
      startsAt: changed,
      endsAt: new Date("2037-09-25T14:00:00.000Z"),
      updatedAt: new Date("2036-08-10T00:00:00.000Z"),
    }).where(eq(appointments.id, appointmentId));
    const result = await turn("Yes");
    expect(result?.reply).toContain("changed since I prepared the proposal");
    expect((await db.select().from(appointments))[0].startsAt.toISOString())
      .toBe(changed.toISOString());
    expect((await db.select().from(automationEvents)
      .where(eq(automationEvents.type, "APPOINTMENT_RESCHEDULED")))).toHaveLength(0);
  });

  it("serializes simultaneous confirmations from two sessions for the same appointment", async () => {
    const otherSession = { ...ctx, sessionKey: "parallel-webchat-session" };
    const secondTurn = async (body: string) => {
      const message = await inbound(body);
      return handleAppointmentManagementTurn(otherSession, { id: message.id, body },
        new Date("2030-09-21T12:00:00.000Z"));
    };
    await turn("Reschedule my appointment");
    await secondTurn("Reschedule my appointment");
    const first = await turn("September 24, 2037 at 10 AM");
    const second = await secondTurn("September 25, 2037 at 10 AM");
    await delivered(first!.preview!.requestId, first!.reply);
    const sent = await appendMessage(ctx.workspaceId, ctx.conversationId!, {
      channel: "WEBCHAT", direction: "OUTBOUND", senderType: "AI",
      contentType: "TEXT", body: second!.reply, status: "DELIVERED", metadata: {},
    });
    await recordAppointmentManagementPreviewDelivery(
      otherSession, second!.preview!.requestId, sent.id, second!.preview!.version,
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    const a = await inbound("Yes");
    const b = await inbound("Yes");
    const results = await Promise.all([
      handleAppointmentManagementTurn(ctx, { id: a.id, body: a.body },
        new Date("2030-09-21T12:00:00.000Z")),
      handleAppointmentManagementTurn(otherSession, { id: b.id, body: b.body },
        new Date("2030-09-21T12:00:00.000Z")),
    ]);
    expect(results.filter(result => result?.reply.includes("rescheduled and confirmed")))
      .toHaveLength(1);
    expect(results.some(result => result?.reply.includes("changed before"))).toBe(true);
    const [saved] = await db.select().from(appointments);
    expect(saved.id).toBe(appointmentId);
    expect(["2037-09-24T10:00:00.000Z", "2037-09-25T10:00:00.000Z"])
      .toContain(saved.startsAt.toISOString());
    expect((await db.select().from(automationEvents)
      .where(eq(automationEvents.type, "APPOINTMENT_RESCHEDULED")))).toHaveLength(1);
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
  });

  it("prevents a second edit when a provider outcome is uncertain", async () => {
    await turn("Reschedule my appointment");
    const preview = await turn("September 24, 2037 at 10 AM");
    await delivered(preview!.preview!.requestId, preview!.reply);
    const provider = vi.spyOn(calendarBookingService, "reschedule")
      .mockRejectedValueOnce(new Error("Provider connection dropped after dispatch"));
    const uncertain = await turn("Yes");
    expect(uncertain?.reply).toContain("haven't confirmed");
    expect((await db.select().from(appointmentManagementRequests)
      .where(eq(appointmentManagementRequests.appointmentId, appointmentId)))
      .some(row => row.status === "RECONCILING")).toBe(true);
    const retry = await turn("Reschedule my appointment");
    expect(retry?.reply).toContain("unresolved calendar outcome");
    expect(provider).toHaveBeenCalledTimes(1);
    const [saved] = await db.select().from(appointments);
    expect(saved.startsAt.toISOString()).toBe(oldStart.toISOString());
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
  });

  it("does not disclose or modify another contact's appointment", async () => {
    const [other] = await db.insert(contacts).values({
      workspaceId: ctx.workspaceId, name: "Other customer",
    }).returning();
    await db.update(appointments).set({ contactId: other.id })
      .where(and(eq(appointments.workspaceId, ctx.workspaceId), eq(appointments.id, appointmentId)));
    const turnResult = await turn("Reschedule my appointment");
    expect(turnResult?.reply).toContain("can't find an upcoming appointment");
    expect(turnResult?.reply).not.toContain("Office Cleaning");
  });

  it("asks which appointment when the contact owns more than one", async () => {
    await db.insert(appointments).values({
      workspaceId: ctx.workspaceId, contactId: ctx.contactId,
      conversationId: ctx.conversationId, title: "Industrial Cleaning",
      startsAt: new Date("2037-09-25T11:00:00.000Z"),
      endsAt: new Date("2037-09-25T15:00:00.000Z"),
      timezone: "UTC", status: "CONFIRMED",
    });
    const first = await turn("I'd like to update my appointment");
    expect(first?.reply).toContain("Which existing appointment");
    expect(first?.reply).toContain("Industrial Cleaning");
    const selected = await turn("Industrial Cleaning");
    expect(selected?.reply).toContain("I found your existing Industrial Cleaning");
  });

  it("does not intercept confirmation for an existing V2 booking draft", async () => {
    await db.insert(bookingDrafts).values({
      workspaceId: ctx.workspaceId, contactId: ctx.contactId,
      conversationId: ctx.conversationId, sessionKey: ctx.sessionKey,
      channel: "WEBCHAT", status: "AWAITING_CONFIRMATION",
      expiresAt: new Date("2038-09-22T00:00:00.000Z"),
    });
    const result = await turn("Yes");
    expect(result).toBeNull();
    expect((await db.select().from(appointments))[0].status).toBe("CONFIRMED");
  });

  it("reads appointment status without creating an edit request", async () => {
    const result = await turn("What's the status of my appointment?");
    expect(result?.reply).toContain("confirmed");
    expect((await db.select().from(appointmentManagementRequests))).toHaveLength(0);
  });
});

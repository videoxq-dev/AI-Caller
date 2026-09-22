import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { appointments, bookingDrafts, contacts, messages, services, workspaces } from "@/db/schema";
import { getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { createVoiceCall, updateVoiceCall } from "./repository";
import { runRealtimeBusinessTool } from "./realtime-tools";
import { recordBookingPreviewDelivery } from "@/server/booking/offers";

describe("Realtime voice booking v2 uses durable booking authority", () => {
  let workspaceId = "", contactId = "", conversationId = "", callId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Realtime booking v2" }).returning();
    workspaceId = workspace.id;
    const [agent] = await db.insert((await import("@/db/schema")).aiAgents).values({
      workspaceId, name: "Mia", status: "ACTIVE",
    }).returning();
    void agent;
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Ada" }).returning();
    contactId = contact.id;
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
    await db.insert(services).values({
      workspaceId, name: "Office Cleaning", durationMinutes: 240, active: true,
    });
    await saveBusinessSetup(workspaceId, {
      businessName: "Office Cleaning", timezone: "Africa/Lagos", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "19:00",
      })),
    });
    const call = await createVoiceCall(workspaceId, {
      conversationId, contactId, integrationId: null, provider: "telnyx",
      externalCallId: "realtime-v2-call", callControlId: "control-v2",
      fromNumber: "+13075550101", toNumber: "+13075550102",
      mode: "AI_FIRST", bookingEngineVersion: "v2",
      metadata: { phase: "ACTIVE", voiceTechnology: "REALTIME", realtimeStreamId: "stream-v2" },
    });
    callId = call.id;
    await updateVoiceCall(workspaceId, callId, { status: "ACTIVE" });
  });

  afterAll(async () => closeDatabase());

  function run(name: string, args: Record<string, unknown>, sourceEventId: string) {
    return runRealtimeBusinessTool({
      workspaceId, conversationId, contactId, callId, streamId: "stream-v2",
      name, arguments: JSON.stringify(args), sourceEventId,
      isCurrentTurn: () => true,
    });
  }

  it("normalizes caller date words server-side, checks the exact four-hour slot, and commits once after delivered readback", async () => {
    const capture = await run("capture_booking_details", {
      serviceName: "Office Cleaning",
      dateExpression: "September 23, 2030",
      timeExpression: "11 AM (Africa/Lagos)",
    }, "tool-capture");
    expect(capture).toMatchObject({ ok: true, kind: "booking_state",
      data: { date: "2030-09-23", time: "11:00", timezone: "Africa/Lagos" } });

    const checked = await run("check_availability", {}, "tool-check");
    if (!checked) throw new Error("Availability tool returned no result.");
    expect(checked.ok).toBe(true);
    expect("data" in checked && checked.data).toMatchObject({ available: true });
    if (!("data" in checked) || !checked.data || !Array.isArray((checked.data as Record<string, unknown>).slots)) {
      throw new Error("Expected verified slots.");
    }
    const slots = (checked.data as { slots: Array<{ startsAt: string; endsAt: string }> }).slots;
    expect(slots[0]).toEqual({
      offerId: expect.any(String),
      startsAt: "2030-09-23T10:00:00.000Z",
      endsAt: "2030-09-23T14:00:00.000Z",
      timezone: "Africa/Lagos",
    });

    const staged = await run("book_appointment", {}, "tool-stage");
    expect(staged).toMatchObject({ ok: true, kind: "pending_action" });
    if (!staged || !("data" in staged)) throw new Error("Expected preview IDs.");
    const data = staged.data as { draftId: string; previewId: string; version: number };

    const [readback] = await db.insert(messages).values({
      workspaceId, conversationId, channel: "PHONE", direction: "OUTBOUND",
      senderType: "AI", contentType: "CALL_TRANSCRIPT",
      body: "Office Cleaning, September 23 at 11 AM Africa/Lagos. Shall I book it?",
      provider: "openai-realtime", status: "SENT",
      metadata: {
        voiceCallId: callId, bookingDraftId: data.draftId,
        bookingPreviewId: data.previewId, bookingVersion: data.version,
        potentiallyInterrupted: false,
      },
    }).returning();
    await recordBookingPreviewDelivery({
      workspaceId, contactId, conversationId, channel: "PHONE", sessionKey: callId,
    }, {
      draftId: data.draftId, previewId: data.previewId, expectedVersion: data.version,
      deliveryChannel: "PHONE", deliveryReference: readback.id,
    });
    await db.insert(messages).values({
      workspaceId, conversationId, channel: "PHONE", direction: "INBOUND",
      senderType: "CUSTOMER", contentType: "CALL_TRANSCRIPT",
      body: "Yes, confirm it.", provider: "telnyx-voice", status: "RECEIVED",
      metadata: { voiceCallId: callId },
      createdAt: new Date(Date.now() + 5),
    });

    const committed = await run("book_appointment", {}, "tool-commit");
    expect(committed).toMatchObject({ ok: true, kind: "booking",
      data: { status: "CONFIRMED",
        startsAt: "2030-09-23T10:00:00.000Z",
        endsAt: "2030-09-23T14:00:00.000Z" } });
    expect(await db.select().from(appointments)).toHaveLength(1);

    const replay = await run("book_appointment", {}, "tool-commit-repeat");
    expect(replay).toMatchObject({ ok: true, kind: "booking" });
    expect(await db.select().from(appointments)).toHaveLength(1);
    expect((await db.select().from(bookingDrafts))[0].status).toBe("CONFIRMED");
  });

  it("will not commit an interrupted or undelivered preview", async () => {
    await run("capture_booking_details", {
      serviceName: "Office Cleaning", dateExpression: "September 23, 2030",
      timeExpression: "11 AM (Africa/Lagos)",
    }, "capture-2");
    await run("check_availability", {}, "check-2");
    const staged = await run("book_appointment", {}, "stage-2");
    expect(staged).toMatchObject({ ok: true, kind: "pending_action" });
    await db.insert(messages).values({
      workspaceId, conversationId, channel: "PHONE", direction: "INBOUND",
      senderType: "CUSTOMER", contentType: "CALL_TRANSCRIPT", body: "Yes.",
      provider: "telnyx-voice", status: "RECEIVED", metadata: { voiceCallId: callId },
    });
    const notCommitted = await run("book_appointment", {}, "commit-2");
    expect(notCommitted).toMatchObject({ ok: true, kind: "pending_action" });
    expect(await db.select().from(appointments)).toHaveLength(0);
  });
});

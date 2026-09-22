import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  aiAgents, appointmentManagementRequests, appointments, automationEvents,
  bookingDrafts, contacts, messages, workspaces,
} from "@/db/schema";
import { getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { recordAppointmentManagementPreviewDelivery } from "@/server/booking/management";
import { createVoiceCall, getVoiceCall, updateVoiceCall } from "./repository";
import { runRealtimeBusinessTool } from "./realtime-tools";

describe("Realtime existing appointment management", () => {
  let workspaceId = "", contactId = "", conversationId = "", callId = "";
  let appointmentId = "";
  const oldStart = new Date("2037-09-23T10:00:00.000Z");

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces)
      .values({ name: "Realtime appointment management" }).returning();
    workspaceId = workspace.id;
    await db.insert(aiAgents).values({
      workspaceId, name: "Mia", status: "ACTIVE",
    });
    const [contact] = await db.insert(contacts)
      .values({ workspaceId, name: "Caller" }).returning();
    contactId = contact.id;
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
    await saveBusinessSetup(workspaceId, {
      businessName: "Cleaning", timezone: "UTC", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "19:00",
      })),
    });
    const [appointment] = await db.insert(appointments).values({
      workspaceId, contactId, conversationId,
      title: "Office Cleaning", status: "CONFIRMED", timezone: "UTC",
      startsAt: oldStart, endsAt: new Date("2037-09-23T14:00:00.000Z"),
    }).returning();
    appointmentId = appointment.id;
    const call = await createVoiceCall(workspaceId, {
      conversationId, contactId, integrationId: null, provider: "telnyx",
      externalCallId: "manage-call", callControlId: "manage-call",
      fromNumber: "+13075550101", toNumber: "+13075550102",
      mode: "AI_FIRST", bookingEngineVersion: "v2",
      metadata: { phase: "ACTIVE", voiceTechnology: "REALTIME",
        realtimeStreamId: "manage-stream" },
    });
    callId = call.id;
    await updateVoiceCall(workspaceId, callId, { status: "ACTIVE" });
  });

  afterAll(closeDatabase);

  function run(message: string) {
    return runRealtimeBusinessTool({
      workspaceId, conversationId, contactId, callId, streamId: "manage-stream",
      name: "manage_appointment", arguments: JSON.stringify({ message }),
      sourceEventId: crypto.randomUUID(), isCurrentTurn: () => true,
    });
  }

  async function spoken(requestId: string, version: number) {
    const [reply] = await db.insert(messages).values({
      workspaceId, conversationId, channel: "PHONE",
      direction: "OUTBOUND", senderType: "AI",
      contentType: "CALL_TRANSCRIPT",
      body: "Please confirm changing your Office Cleaning appointment to September 24, 2037 at 10 AM.",
      status: "SENT", provider: "openai-realtime",
      metadata: { voiceCallId: callId, potentiallyInterrupted: false },
    }).returning();
    await recordAppointmentManagementPreviewDelivery({
      workspaceId, contactId, conversationId, sessionKey: callId, channel: "PHONE",
    }, requestId, reply.id, version);
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  it("requires persisted same-call customer confirmation, then reschedules the original appointment", async () => {
    const initial = await run("Please change my appointment");
    expect(initial).toMatchObject({ ok: true, kind: "appointment_management" });
    const preview = await run("September 24, 2037 at 10 AM");
    expect(preview).toMatchObject({
      ok: true, kind: "appointment_management",
      data: { awaitingConfirmation: true },
    });
    const [request] = await db.select().from(appointmentManagementRequests);
    expect(await getVoiceCall(workspaceId, callId)).toMatchObject({
      metadata: { appointmentManagementAwaitingRealtimeDelivery: {
        requestId: request.id, version: request.version,
      } },
    });
    const premature = await run("Yes");
    expect(premature).toMatchObject({ ok: true,
      data: { spokenInstruction: expect.stringContaining("haven't delivered") },
    });
    expect((await db.select().from(appointments))[0].startsAt.toISOString())
      .toBe(oldStart.toISOString());

    await spoken(request.id, request.version);
    const unverified = await run("Yes");
    expect(unverified).toMatchObject({ ok: true,
      data: { spokenInstruction: expect.stringContaining("Please confirm only after") },
    });

    await db.insert(messages).values({
      workspaceId, conversationId, channel: "PHONE", direction: "INBOUND",
      senderType: "CUSTOMER", contentType: "CALL_TRANSCRIPT",
      body: "Yes.", status: "RECEIVED", provider: "telnyx-voice",
      metadata: { voiceCallId: callId },
      createdAt: new Date(Date.now() + 200),
    });
    const result = await run("Yes");
    expect(result).toMatchObject({ ok: true,
      data: { spokenInstruction: expect.stringContaining("rescheduled and confirmed") },
    });
    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(appointmentId);
    expect(rows[0].startsAt.toISOString()).toBe("2037-09-24T10:00:00.000Z");
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
    expect((await db.select().from(automationEvents)
      .where(eq(automationEvents.type, "APPOINTMENT_RESCHEDULED")))).toHaveLength(1);
  });

  it("honors capability revocation mid-call before creating an appointment edit", async () => {
    await db.update(aiAgents).set({
      behaviorSettings: {
        capabilities: { ...defaultAgentCapabilities,
          RESCHEDULE_APPOINTMENT: false, CANCEL_APPOINTMENT: false },
      },
    }).where(eq(aiAgents.workspaceId, workspaceId));
    const denied = await run("Please change my appointment");
    expect(denied).toMatchObject({
      ok: false, code: "AGENT_ACTION_DISABLED",
    });
    expect(await db.select().from(appointmentManagementRequests)).toHaveLength(0);
    expect((await db.select().from(appointments))[0].startsAt.toISOString())
      .toBe(oldStart.toISOString());
  });
});

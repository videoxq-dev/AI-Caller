import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { aiAgents, contacts, pendingAgentActions, services, workspaces } from "@/db/schema";
import { appendMessage, getOrCreateOpenConversation, listAppointments } from "@/server/domain/core/repository";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { createVoiceCall, updateVoiceCall } from "@/server/voice/repository";
import { realtimeSessionContext, runRealtimeBusinessTool } from "@/server/voice/realtime-tools";
import { buildConversationContext } from "./context";
import { createResponseOrchestrator } from "./index";
import { getAwaitingPendingAction } from "./pending-actions";
import { executeOrchestratorTools } from "./tools";

describe("appointment booking regressions from chat and calls", () => {
  let workspaceId: string;
  let contactId: string;
  let conversationId: string;
  let serviceId: string;
  let callId: string;
  const slot = {
    startsAt: "2037-09-23T11:00:00+01:00",
    endsAt: "2037-09-23T15:00:00+01:00",
    timezone: "Africa/Lagos",
  };

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Booking regression" }).returning();
    workspaceId = workspace.id;
    await db.insert(aiAgents).values({ workspaceId, name: "Assistant", status: "ACTIVE" });
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Customer" }).returning();
    contactId = contact.id;
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
    const [service] = await db.insert(services).values({ workspaceId, name: "Office Cleaning", durationMinutes: 240 }).returning();
    serviceId = service.id;
    await saveBusinessSetup(workspaceId, {
      businessName: "Cleaning", timezone: "Africa/Lagos", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "18:00",
      })),
    });
    const call = await createVoiceCall(workspaceId, {
      conversationId, contactId, integrationId: null, provider: "telnyx",
      externalCallId: "booking-regression", callControlId: "booking-regression",
      fromNumber: "+13075550101", toNumber: "+13075550102", mode: "AI_FIRST",
      metadata: { voiceTechnology: "REALTIME", realtimeStreamId: "test-stream" },
    });
    callId = call.id;
    await updateVoiceCall(workspaceId, callId, { status: "ACTIVE" });
  });
  afterAll(closeDatabase);

  async function message(body: string, senderType: "AI" | "CUSTOMER", channel: "WEBCHAT" | "PHONE" = "WEBCHAT") {
    return appendMessage(workspaceId, conversationId, {
      channel, senderType, direction: senderType === "AI" ? "OUTBOUND" : "INBOUND",
      contentType: channel === "PHONE" ? "CALL_TRANSCRIPT" : "TEXT",
      body, provider: null, externalMessageId: null, status: "RECEIVED",
      metadata: channel === "PHONE" ? { voiceCallId: callId } : {},
    });
  }
  function tool(name: string, args: Record<string, unknown>) {
    return runRealtimeBusinessTool({
      workspaceId, conversationId, contactId, callId, streamId: "test-stream",
      name, arguments: JSON.stringify(args), isCurrentTurn: () => true,
    });
  }
  const booking = () => ({ ...slot, title: "Office Cleaning", serviceId });

  it("repairs leaked JSON, stages the chosen slot, and persists the appointment on approved", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ action: {
        type: "CHECK_AVAILABILITY", ...slot, durationMinutes: 240,
      } }) })
      // Reproduce the screenshot's unclosed unresolved object containing action.
      .mockResolvedValueOnce({ text: '{"reply":"Please approve.","unresolved":{"reason":"","action":'
        + JSON.stringify({ type: "BOOK_APPOINTMENT", ...booking() }) + '}' })
      .mockResolvedValueOnce({ text: JSON.stringify({ action: { type: "BOOK_APPOINTMENT", ...booking() } }) });
    const orchestrator = createResponseOrchestrator({
      buildContext: buildConversationContext, executeTools: executeOrchestratorTools,
      getAwaitingAction: getAwaitingPendingAction, generate,
    });
    await message("Check Office Cleaning on September 23 2037 at 10 AM UTC.", "CUSTOMER");
    const available = await orchestrator.respond(workspaceId, conversationId);
    expect(available.toolResult.kind).toBe("availability");
    expect(available.reply).toContain("11:00 AM");
    await message(available.reply!, "AI");
    await message("Sep 23, 2037, 11:00 AM (Africa/Lagos) is perfectly fine", "CUSTOMER");
    const staged = await orchestrator.respond(workspaceId, conversationId);
    expect(staged.toolResult.kind).toBe("pending_action");
    expect(staged.reply).not.toContain('"action"');
    expect((await listAppointments(workspaceId)).total).toBe(0);
    await message(staged.reply!, "AI");
    await message("approved", "CUSTOMER");
    const booked = await orchestrator.respond(workspaceId, conversationId);
    expect(booked.toolResult).toMatchObject({ kind: "booking", data: { status: "CONFIRMED" } });
    expect(generate).toHaveBeenCalledTimes(3); // No model replan on approval.
    const appointments = await listAppointments(workspaceId);
    expect(appointments.total).toBe(1);
    expect((await db.select().from(pendingAgentActions))[0].status).toBe("EXECUTED");
  });

  it.each(["Confirmed.", "approved"])("books through realtime tools on %s without external calendar credentials", async approval => {
    await message("Office Cleaning on September 23 2037 at 11 AM at 12 Main Street.", "CUSTOMER", "PHONE");
    expect(await tool("capture_booking_details", {
      serviceName: "Office Cleaning", location: "12 Main Street",
      date: "2037-09-23", time: "11:00", timezone: "Africa/Lagos",
    })).toMatchObject({ ok: true });
    expect(await tool("check_availability", { ...slot, durationMinutes: 240 }))
      .toMatchObject({ ok: true, kind: "availability" });
    expect(await tool("book_appointment", booking()))
      .toMatchObject({ ok: true, kind: "pending_action" });
    expect((await listAppointments(workspaceId)).total).toBe(0);
    await message("Office Cleaning September 23 at 11 AM Africa/Lagos. Please confirm to book.", "AI", "PHONE");
    await message(approval, "CUSTOMER", "PHONE");
    expect(await tool("book_appointment", booking()))
      .toMatchObject({ ok: true, kind: "booking", data: { status: "CONFIRMED" } });
    expect(await tool("book_appointment", booking()))
      .toMatchObject({ ok: true, kind: "booking", data: { status: "CONFIRMED" } });
    expect((await listAppointments(workspaceId)).total).toBe(1);
  });

  it("keeps an earlier webchat date out of the current call's history", async () => {
    await message("Book September 23 at 10 AM UTC.", "CUSTOMER");
    await message('{"reply":"September 23 has passed","action":{"type":"NONE"}}', "AI");
    await message("Office cleaning September 22 at 10 AM.", "CUSTOMER", "PHONE");
    const context = await realtimeSessionContext(workspaceId, conversationId, callId);
    expect(context.history).toContain("September 22");
    expect(context.history).not.toContain("September 23");
    expect(context.history).not.toContain('"action"');
  });

  it("requires a new availability check when the caller corrects the date", async () => {
    await message("Office Cleaning September 23 at 11 AM.", "CUSTOMER", "PHONE");
    await tool("capture_booking_details", {
      serviceName: "Office Cleaning", location: "12 Main Street",
      date: "2037-09-23", time: "11:00", timezone: "Africa/Lagos",
    });
    await tool("check_availability", { ...slot, durationMinutes: 240 });
    await tool("book_appointment", booking());
    await message("Please confirm to book September 23.", "AI", "PHONE");
    await message("No, September 22 instead.", "CUSTOMER", "PHONE");
    await tool("capture_booking_details", { date: "2037-09-22" });
    expect(await tool("book_appointment", booking())).toMatchObject({ ok: false });
    expect((await listAppointments(workspaceId)).total).toBe(0);
  });
});

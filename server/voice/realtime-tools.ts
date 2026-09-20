import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { buildConversationContext } from "@/server/orchestrator/context";
import { executeOrchestratorTools, orchestratorActionSchema } from "@/server/orchestrator/tools";
import { getConversationById } from "@/server/domain/core/repository";
import { assertRealtimeBookingReady, captureRealtimeBookingDetails, saveRealtimeAvailability } from "./realtime-booking";
import { getVoiceCall } from "./repository";

export const realtimeTools = [
  {
    type: "function", name: "capture_booking_details",
    description: "Record only booking details the caller has clearly provided. Call again when they correct details. Never invent missing values.",
    parameters: { type: "object", properties: {
      serviceName: { type: "string" }, location: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD; ask if the year is ambiguous" },
      time: { type: "string", description: "HH:MM in business local time" },
      timezone: { type: "string", description: "IANA time zone" },
    } },
  },
  {
    type: "function", name: "check_availability",
    description: "Check actual calendar availability. Do not claim a slot is available until this returns it.",
    parameters: { type: "object", properties: {
      startsAt: { type: "string", description: "ISO 8601 datetime with offset" },
      endsAt: { type: "string", description: "ISO 8601 datetime with offset" },
      timezone: { type: "string", description: "IANA time zone" },
      durationMinutes: { type: "integer" },
    }, required: ["startsAt", "endsAt", "timezone"] },
  },
  {
    type: "function", name: "book_appointment",
    description: "Book only AFTER an availability check AND explicit customer approval following an audible confirmation question.",
    parameters: { type: "object", properties: {
      startsAt: { type: "string" }, endsAt: { type: "string" },
      timezone: { type: "string" }, title: { type: "string" },
      serviceId: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
    }, required: ["startsAt", "endsAt", "timezone", "title"] },
  },
  {
    type: "function", name: "escalate_to_staff",
    description: "Flag the Inbox conversation for human follow-up. NO live telephone transfer exists.",
    parameters: { type: "object", properties: { reason: { type: "string" } },
      required: ["reason"] },
  },
  {
    type: "function", name: "qualify_lead",
    description: "Save configured qualification answers if they were explicitly provided by the caller.",
    parameters: { type: "object", properties: { answers: {
      type: "array", items: { type: "object", properties: {
        criterionId: { type: "string" }, answer: { type: "string" },
      }, required: ["criterionId", "answer"] },
    } }, required: ["answers"] },
  },
] as const;

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export async function runRealtimeBusinessTool(input: {
  workspaceId: string; conversationId: string; contactId: string;
  callId: string; streamId: string;
  name: string; arguments: string;
}) {
  const [convo, call] = await Promise.all([
    getConversationById(input.workspaceId, input.conversationId),
    getVoiceCall(input.workspaceId, input.callId),
  ]);
  if (!convo || convo.handlingMode !== "AI"
    || !call || call.conversationId !== input.conversationId
    || call.contactId !== input.contactId || call.status !== "ACTIVE"
    || call.metadata.voiceTechnology !== "REALTIME"
    || call.metadata.realtimeStreamId !== input.streamId) {
    return { ok: false, reason: "The call is no longer authorized for AI actions." };
  }
  let args: Record<string, unknown>;
  try { args = record(JSON.parse(input.arguments)); }
  catch { return { ok: false, reason: "The tool arguments were invalid." }; }
  if (input.name === "capture_booking_details") {
    try {
      const saved = await captureRealtimeBookingDetails(input.workspaceId, input.callId, args);
      return { ok: true as const, kind: "booking_state" as const, data: saved };
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return { ok: false as const, reason: "Please collect valid booking details before storing them." };
      }
      throw error;
    }
  }
  const actions: Record<string, string> = {
    check_availability: "CHECK_AVAILABILITY",
    book_appointment: "BOOK_APPOINTMENT",
    escalate_to_staff: "ESCALATE",
    qualify_lead: "QUALIFY_LEAD",
  };
  const type = actions[input.name];
  if (!type) return { ok: false, reason: "Unsupported business action." };
  const parsed = orchestratorActionSchema.safeParse({ type, ...args });
  if (!parsed.success) return { ok: false, reason: "Please collect the missing booking details before trying again." };

  if (parsed.data.type === "BOOK_APPOINTMENT") {
    try {
      await assertRealtimeBookingReady(input.workspaceId, input.callId, parsed.data);
    } catch (error) {
      if (error instanceof AppError) return { ok: false as const, reason: error.message };
      throw error;
    }
    // A model assertion is not a customer's consent. Verify persisted call
    // utterances and that the AI actually asked for confirmation.
    const history = await db.select({ body: messages.body, sender: messages.senderType,
      channel: messages.channel, contentType: messages.contentType,
    }).from(messages).where(and(
      eq(messages.workspaceId, input.workspaceId), eq(messages.conversationId, input.conversationId),
      eq(messages.channel, "PHONE"), eq(messages.contentType, "CALL_TRANSCRIPT"),
      sql`${messages.metadata}->>'voiceCallId' = ${input.callId}`,
    )).orderBy(desc(messages.createdAt)).limit(10);
    const customerIndex = history.findIndex(row => row.sender === "CUSTOMER");
    const customer = customerIndex < 0 ? "" : history[customerIndex].body.trim();
    const question = history.slice(customerIndex + 1).find(row => row.sender === "AI")?.body ?? "";
    if (!/^(yes|yeah|yep|sure|please|okay|ok|confirm|go ahead|book it|sounds good)\b/i.test(customer)
      || !/\b(confirm|book|schedule|reserve)\b/i.test(question)) {
      return { ok: false, reason: "Ask the caller to explicitly approve this specific appointment before booking." };
    }
  }

  try {
    const result = await executeOrchestratorTools(input.workspaceId,
      input.conversationId, input.contactId, { action: parsed.data });
    if (parsed.data.type === "CHECK_AVAILABILITY") {
      const start = parsed.data.startsAt;
      const slots = Array.isArray(result.data.slots) ? result.data.slots : [];
      const available = slots.some(slot => record(slot).startsAt === start);
      await saveRealtimeAvailability(input.workspaceId, input.callId, start, available);
    }
    return { ok: true as const, ...result, ...(result.kind === "escalation"
      ? { spokenInstruction: "Tell the caller staff will follow up. Never promise a live phone transfer." } : {}) };
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return { ok: false, reason: error.message };
    throw error;
  }
}

/** The existing business context is the source of truth for both voice engines. */
export async function realtimeSystemInstructions(workspaceId: string, conversationId: string) {
  const context = await buildConversationContext(workspaceId, conversationId);
  if (!context || context.conversation.handlingMode !== "AI") throw new Error("Realtime conversation unavailable.");
  return `${context.systemPrompt}

REALTIME CALL: Speak naturally and concisely, never produce JSON to the caller.
Listen through natural pauses; consider the latest correction authoritative. Keep
known service, location, date, time and timezone in working memory. Ask ONLY for
missing details; when the caller supplies a date, ask for time rather than both.
Use business tools to check availability, then ask the customer to approve
a specific service/date/time before invoking book_appointment. Do not invent
availability, bookings or transfers. Use escalate_to_staff for a human request
and say this is staff follow-up, not a live transfer. Avoid unrequested SMS.
Current business time zone: ${context.timezone}.`;
}

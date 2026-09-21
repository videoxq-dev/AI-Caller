import { AppError } from "@/server/http/errors";
import { capabilitiesFromBehaviorSettings } from "@/server/agent/capabilities";
import { logger } from "@/server/observability/logger";
import { buildConversationContext, type OrchestratorContext } from "./context";
import {
  executeOrchestratorTools,
  parseOrchestratorEnvelope,
  type OrchestratorEnvelope,
  type OrchestratorToolResult,
} from "./tools";
import { generateAIWithUsage } from "./usage";
import type { AIProvider } from "@/server/providers/contracts";

type AIMessage = Parameters<AIProvider["generate"]>[0]["messages"][number];

export type OrchestratorResponseOptions = {
  // Transcription can supersede a proposed reply while the model is thinking.
  // Guard before executing potentially irreversible calendar/SMS actions.
  beforeTools?: () => Promise<boolean>;
};

function isExplicitHumanRequest(message: string) {
  const text = message.trim().toLowerCase().replace(/[?!.,]+$/g, "");
  return /^(?:a|an|the)?\s*(?:human|operator|representative|real person|live person)(?: please)?$/.test(text)
    || /\b(?:speak|talk|connect|transfer|reach|want|need|like|get)\b[^.!?]{0,100}\b(?:human|operator|representative|real person|live person|staff member|team member|person)\b/.test(text);
}

const LIVE_PHONE_ESCALATION_REPLY = "I've flagged your request for our team to follow up. I can't transfer this call live.";


function safeLivePhoneReply(reply: string) {
  // Without a completed escalation, a model cannot promise an actual live
  // Call Control transfer: this version supports staff Inbox follow-up only.
  if (/\b(?:i(?:['’]ll| will| can)|we(?:['’]ll| will| can)|let me)\s+[^.!?]{0,55}\b(?:connect|transfer|put you through|patch you through)\b[^.!?]{0,75}\b(?:team|staff|human|operator|person|representative|someone|you)\b/i.test(reply)) {
    return "I can answer questions about the business here. If you need a person, I can flag your request for staff follow-up, but I can't transfer this call live.";
  }
  return reply;
}


type OrchestratorDependencies = {
  buildContext: (workspaceId: string, conversationId: string) => Promise<OrchestratorContext | null>;
  executeTools: (
    workspaceId: string,
    conversationId: string,
    contactId: string,
    envelope: OrchestratorEnvelope,
  ) => Promise<OrchestratorToolResult>;
  generate: (workspaceId: string, referenceId: string, messages: AIMessage[]) => Promise<{ text: string }>;
};

const ACTION_PROTOCOL = `
Return exactly one JSON object and no prose outside it.
Shape:
{
  "reply": "short customer-facing response when no server result is required",
  "contact": { "name": "explicitly provided name", "email": "explicitly provided email", "phone": "explicitly provided phone" },
  "lead": { "status": "NEW|QUALIFIED", "intent": "...", "serviceRequested": "..." },
  "action": { "type": "NONE" }
}

Allowed action objects:
- { "type": "NONE" }
- { "type": "RECORD_SMS_CONSENT", "category": "TRANSACTIONAL|MARKETING|ALL", "status": "OPTED_IN|OPTED_OUT" }
- { "type": "SEND_SMS", "text": "customer-facing SMS body" }
- { "type": "CHECK_AVAILABILITY", "startsAt": "ISO-8601 with offset", "endsAt": "ISO-8601 with offset", "timezone": "IANA timezone", "durationMinutes": 30 }
- { "type": "BOOK_APPOINTMENT", "startsAt": "ISO-8601 with offset", "endsAt": "ISO-8601 with offset", "timezone": "IANA timezone", "title": "...", "serviceId": null, "notes": null }
- { "type": "QUALIFY_LEAD", "answers": [{ "criterionId": "configured_id", "answer": "explicit customer answer" }] }
- { "type": "ESCALATE", "reason": "..." }

Rules:
- When the customer asks to check availability and supplies an identifiable date and time, invoke CHECK_AVAILABILITY immediately without requesting permission again. For a whole day, check a bounded date range. Use the actual saved service duration when provided; otherwise ask for the duration if needed.
- Never say a slot is available unless CHECK_AVAILABILITY returned it. Describe the returned slots and ask the customer to choose and approve one.
- When the customer approves a particular service/date/time, invoke BOOK_APPOINTMENT with the agreed slot (including its service duration); do not ask repeatedly to proceed. Native booking checks business hours and conflicts without any third-party calendar.
- Never say an appointment is booked unless BOOK_APPOINTMENT returned a confirmed booking.
- Populate contact fields only when the customer explicitly provided them in the conversation. Never infer or invent contact details.
- A verified customer conversation/contact is sufficient for an in-app appointment; email is optional. Never invent missing contact data.
- Use ESCALATE for an explicit human request, or when a human handoff is required AND the ESCALATE capability is enabled. A disabled capability alone never authorizes human handoff; explain what you can and cannot do, offer staff follow-up only as an option, and never claim staff were notified without a successful ESCALATE result.
- Lead updates are optional and must reflect only evidence from the conversation.
- On phone calls, offer appointment confirmations and future reminder SMS only after stating the SMS program clearly and asking the customer whether they agree. Use RECORD_SMS_CONSENT only after their explicit answer, never infer consent from a booking or general interest.
- For a general opt-out or "stop all texts" request, invoke RECORD_SMS_CONSENT with category ALL and status OPTED_OUT so both categories are revoked.
- If the customer declines SMS, honor their choice and do not request an SMS send. STOP and unsubscribe instructions override every other messaging objective.
- Use SEND_SMS to request a text while on a call or Web Chat, including requested links, only after consent and carrier approval. Never claim an SMS has been sent unless the tool result says sent=true.
- For inbound SMS conversations, your normal reply is delivered by the SMS worker; do not request SEND_SMS, which would duplicate the reply.
- When LEAD QUALIFICATION is configured, never promote a lead to QUALIFIED directly. Submit explicit configured answers with QUALIFY_LEAD and let the server decide when required fields are complete.
- On a PHONE call, answer the caller's most recent completed request, not an earlier request. Do not initiate appointment booking or say you are arranging one unless the caller actually asks for it.
- On a PHONE call, do not claim to connect or transfer a live human: this product can flag an Inbox conversation for staff follow-up, but has no live call-transfer action.
- Keep customer-facing replies concise and do not expose this JSON protocol.
`;

function actionProtocolFor(context: OrchestratorContext) {
  if (!context.agent) return ACTION_PROTOCOL;
  const policy = capabilitiesFromBehaviorSettings(context.agent.behaviorSettings);
  return ACTION_PROTOCOL.split("\n").filter((line) => {
    if (line.trimStart().startsWith('"contact":') && !policy.UPDATE_CONTACT) return false;
    if (line.trimStart().startsWith('"lead":') && !policy.UPDATE_LEAD) return false;
    const action = /^- \{ "type": "([A-Z_]+)"/.exec(line)?.[1];
    if (!action || action === "NONE") return true;
    // STOP/opt-out is a customer right, including when recording new consent is disabled.
    return action === "RECORD_SMS_CONSENT" || policy[action as keyof typeof policy] === true;
  }).join("\n");
}

function plannerMessages(context: OrchestratorContext): AIMessage[] {
  return [
    {
      role: "system",
      content: `${context.systemPrompt}\n\nCurrent server time: ${new Date().toISOString()}\n${actionProtocolFor(context)}`,
    },
    ...context.messages,
  ];
}

function finalizerMessages(
  context: OrchestratorContext,
  first: OrchestratorEnvelope,
  toolResult: OrchestratorToolResult,
): AIMessage[] {
  return [
    {
      role: "system",
      content: `${context.systemPrompt}\n\nCurrent server time: ${new Date().toISOString()}\n${actionProtocolFor(context)}`,
    },
    ...context.messages,
    {
      role: "assistant",
      content: JSON.stringify(first),
    },
    {
      role: "system",
      content: `SERVER TOOL RESULT (authoritative): ${JSON.stringify(toolResult)}\nReturn a final JSON envelope with a customer-facing reply and action {"type":"NONE"}. Do not request another tool action in this response.`,
    },
  ];
}

function approvedToolFailure(action: OrchestratorEnvelope["action"]["type"], error: AppError) {
  if (action === "CHECK_AVAILABILITY") {
    return error.code === "AGENT_ACTION_DISABLED"
      ? "I can't check appointment availability at the moment. You can ask for staff follow-up if you prefer."
      : `I couldn't check live availability: ${error.message} I haven't reserved a time.`;
  }
  if (action === "BOOK_APPOINTMENT") {
    return error.code === "AGENT_ACTION_DISABLED"
      ? "I can discuss appointment options, but I can't book an appointment right now. Nothing has been booked."
      : `I couldn't book that appointment: ${error.message} Nothing has been booked.`;
  }
  if (action === "ESCALATE") return "I couldn't arrange staff follow-up. Please contact the business directly.";
  return error.code === "AGENT_ACTION_DISABLED"
    ? "I can't perform that action at the moment. No changes were made."
    : `I couldn't complete that action: ${error.message}`;
}
function safeUnverifiedReply(reply: string) {
  if (/\b(?:i(?:['’]ve| have|['’]ll| will)|we(?:['’]ve| have|['’]ll| will))\s+(?:already\s+)?(?:flagged|notified|alerted|asked|contacted|forwarded|passed|sent|flag|notify|alert|ask|contact|forward|pass|send)\b[^.!?]{0,90}\b(?:team|staff|manager|human|representative)\b/i.test(reply)) {
    return "I can answer questions here. If you'd like staff follow-up, please ask me to arrange it.";
  }
  if (/\b(?:your\s+)?appointment\s+(?:is|has been|was)\s+(?:booked|confirmed|scheduled|reserved)\b|\bi(?:['’]ve| have)\s+(?:booked|confirmed|scheduled|reserved)\s+(?:your|the)\s+appointment\b/i.test(reply)) {
    return "I haven't confirmed an appointment yet. Would you like me to check the requested time?";
  }
  return reply;
}

function availabilityReply(toolResult: OrchestratorToolResult, timezone: string) {
  const slots = Array.isArray(toolResult.data.slots) ? toolResult.data.slots : [];
  if (!slots.length) {
    return "I checked the schedule and found no available slots in that window. Would you like to try another date or time?";
  }
  const names = slots.slice(0, 4).flatMap((item) => {
    if (!item || typeof item !== "object" || !("startsAt" in item)) return [];
    const start = new Date(String(item.startsAt));
    if (!Number.isFinite(start.getTime())) return [];
    return [new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium", timeStyle: "short", timeZone: timezone,
    }).format(start)];
  });
  return names.length
    ? `I checked the schedule. Available times include ${names.join("; ")} (${timezone}). Which would you like me to book?`
    : "I couldn't read the returned appointment times. Please try another availability check.";
}

function bookingFallback(toolResult: OrchestratorToolResult) {
  const title = typeof toolResult.data.title === "string" ? toolResult.data.title : "appointment";
  const startsAt = typeof toolResult.data.startsAt === "string" ? toolResult.data.startsAt : null;
  const timezone = typeof toolResult.data.timezone === "string" ? toolResult.data.timezone : "UTC";
  if (!startsAt) return `Your ${title} is booked.`;

  const parsed = new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return `Your ${title} is booked.`;
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(parsed);
  return `Your ${title} is booked for ${formatted} (${timezone}).`;
}

export function createResponseOrchestrator(dependencies: OrchestratorDependencies) {
  return {
    async respond(workspaceId: string, conversationId: string, options: OrchestratorResponseOptions = {}) {
      const context = await dependencies.buildContext(workspaceId, conversationId);
      if (!context) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
      if (context.conversation.handlingMode === "HUMAN") {
        return {
          reply: null,
          handlingMode: "HUMAN" as const,
          action: { type: "NONE" as const },
          toolResult: { kind: "none" as const, data: {} },
        };
      }

      // Only private test mode may use a DRAFT or PAUSED agent. Live inbound turns
      // are suppressed before invoking or charging an AI provider.
      if (context.source === "INBOUND_TURN") {
        const capabilities = context.agent ? capabilitiesFromBehaviorSettings(context.agent.behaviorSettings) : null;
        if (!context.agent || context.agent.status !== "ACTIVE" || !capabilities?.ANSWER_INQUIRY) {
          return { reply: null, handlingMode: "AI" as const, action: { type: "NONE" as const },
            toolResult: { kind: "none" as const, data: {} } };
        }
      }
      const isLivePhone = context.systemPrompt.includes("LIVE PHONE RECEPTIONIST:");
      const lastUserMessage = [...context.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      if (isLivePhone && isExplicitHumanRequest(lastUserMessage)) {
        if (options.beforeTools && !(await options.beforeTools())) {
          return { reply: null, handlingMode: "AI" as const, action: { type: "NONE" as const },
            toolResult: { kind: "none" as const, data: {} } };
        }
        const action = { type: "ESCALATE" as const, reason: "Caller requested a human during a phone call." };
        const noEscalation = {
          reply: "I can't arrange staff follow-up from this call. Please contact the business directly to speak with the team.",
          handlingMode: "AI" as const,
          action: { type: "NONE" as const },
          toolResult: { kind: "none" as const, data: {} },
        };
        if (context.agent && !capabilitiesFromBehaviorSettings(context.agent.behaviorSettings).ESCALATE) {
          return noEscalation;
        }
        try {
          const toolResult = await dependencies.executeTools(workspaceId, conversationId, context.contact.id, { action });
          return { reply: LIVE_PHONE_ESCALATION_REPLY, handlingMode: "HUMAN" as const, action, toolResult };
        } catch (error) {
          if (error instanceof AppError && error.code === "AGENT_ACTION_DISABLED") return noEscalation;
          if (error instanceof AppError && (
            error.code === "AGENT_NOT_ACTIVE" || error.code === "AGENT_NOT_CONFIGURED"
            || error.code === "CONVERSATION_HUMAN_HANDLING"
          )) {
            return { reply: null, handlingMode: "AI" as const,
              action: { type: "NONE" as const },
              toolResult: { kind: "none" as const, data: {} } };
          }
          throw error;
        }
      }

      const firstResponse = await dependencies.generate(workspaceId, conversationId, plannerMessages(context));
      const planned = parseOrchestratorEnvelope(firstResponse.text);
      const allowed = context.agent
        ? capabilitiesFromBehaviorSettings(context.agent.behaviorSettings)
        : null;
      // Capability denials are not an instruction to silently hand the
      // customer to staff. Human ownership requires an actual requested or
      // independently justified escalation, not just a missing tool.
      if (planned.action.type === "ESCALATE" && allowed
        && !isExplicitHumanRequest(lastUserMessage)) {
        const wantsAvailability = /\b(?:available|availability|open slots?|check times?)\b/i.test(lastUserMessage);
        const wantsBooking = /\b(?:book|booking|reserve|appointment|schedule)\b/i.test(lastUserMessage);
        if ((wantsAvailability && !allowed.CHECK_AVAILABILITY)
          || (wantsBooking && !allowed.BOOK_APPOINTMENT && !allowed.CHECK_AVAILABILITY)) {
          return {
            reply: wantsAvailability
              ? "I can't check live appointment availability at the moment. No time has been reserved. Would you like to ask for staff follow-up?"
              : "I can't book an appointment right now. Nothing has been booked. You can ask for staff follow-up if you'd like.",
            handlingMode: "AI" as const, action: { type: "NONE" as const },
            toolResult: { kind: "none" as const, data: {} },
          };
        }
      }
      // Treat the model's metadata as optional hints. A disabled metadata
      // capability cannot fail an otherwise valid answer or cause side effects.
      // The executor still rechecks permissions on current DB state, including
      // after a capability was revoked while the AI was generating.
      const first: OrchestratorEnvelope = {
        ...planned,
        contact: allowed && !allowed.UPDATE_CONTACT ? undefined : planned.contact,
        lead: allowed && !allowed.UPDATE_LEAD ? undefined
          : allowed && !allowed.QUALIFY_LEAD && planned.lead?.status === "QUALIFIED"
            ? { ...planned.lead, status: undefined } : planned.lead,
      };
      if (options.beforeTools && !(await options.beforeTools())) {
        return { reply: null, handlingMode: "AI" as const, action: { type: "NONE" as const },
          toolResult: { kind: "none" as const, data: {} } };
      }
      let toolResult: OrchestratorToolResult;
      try {
        toolResult = await dependencies.executeTools(
          workspaceId,
          conversationId,
          context.contact.id,
          first,
        );
      } catch (error) {
        if (error instanceof AppError && (
          error.code === "AGENT_NOT_ACTIVE" || error.code === "AGENT_NOT_CONFIGURED"
          || error.code === "CONVERSATION_HUMAN_HANDLING"
        )) {
          return { reply: null, handlingMode: "AI" as const,
            action: { type: "NONE" as const },
            toolResult: { kind: "none" as const, data: {} } };
        }
        if (error instanceof AppError && (error.code === "AGENT_ACTION_DISABLED"
          || ["APPOINTMENT_SLOT_UNAVAILABLE", "APPOINTMENT_OUTSIDE_HOURS",
              "APPOINTMENT_IN_PAST", "BUSINESS_HOURS_NOT_CONFIGURED",
              "AVAILABILITY_RANGE_INVALID", "CALENDAR_NOT_CONFIGURED"].includes(error.code))) {
          return { reply: approvedToolFailure(first.action.type, error),
            handlingMode: "AI" as const, action: { type: "NONE" as const },
            toolResult: { kind: "none" as const, data: {} } };
        }
        throw error;
      }

      if (toolResult.kind === "availability") {
        // Present verified calendar slots directly, not a second model's
        // possible assertion that it never checked or an invented opening.
        return { reply: availabilityReply(toolResult, context.timezone ?? "UTC"),
          handlingMode: "AI" as const, action: first.action, toolResult };
      }

      if (toolResult.kind === "booking") {
        // A persisted appointment must always receive its exact server-backed
        // confirmation, even if a second model call would deny or alter it.
        return { reply: bookingFallback(toolResult),
          handlingMode: "AI" as const, action: first.action, toolResult };
      }
      if (toolResult.kind === "qualification" || toolResult.kind === "sms") {
        try {
          const finalResponse = await dependencies.generate(
            workspaceId,
            conversationId,
            finalizerMessages(context, first, toolResult),
          );
          const finalEnvelope = parseOrchestratorEnvelope(finalResponse.text);
          if (!finalEnvelope.reply) throw new Error("AI provider did not return a customer-facing response after the tool call.");
          return {
            reply: finalEnvelope.reply,
            handlingMode: "AI" as const,
            action: first.action,
            toolResult,
          };
        } catch (error) {
          if (toolResult.kind === "sms") {
            logger.error({ err: error, workspaceId, conversationId }, "SMS tool finalized but AI response failed; returning authoritative SMS status");
            return {
              reply: toolResult.data.sent === true ? "I have sent the requested text message." : String(toolResult.data.reason ?? "I could not send that text message."),
              handlingMode: "AI" as const, action: first.action, toolResult,
            };
          }
          throw error;
        }
      }

      if (toolResult.kind === "consent") {
        return {
          reply: first.reply ?? (toolResult.data.status === "OPTED_IN"
            ? "Thank you. I've noted your SMS preference for the messaging program."
            : "Understood. I've recorded that you do not want those SMS messages."),
          handlingMode: "AI" as const,
          action: first.action,
          toolResult,
        };
      }

      if (toolResult.kind === "escalation") {
        return {
          reply: isLivePhone ? LIVE_PHONE_ESCALATION_REPLY
            : "I've flagged your request for staff follow-up. A team member can continue this conversation here when available.",
          handlingMode: "HUMAN" as const,
          action: first.action,
          toolResult,
        };
      }

      if (!first.reply && toolResult.kind !== "contact") throw new Error("AI provider did not return a customer-facing response.");
      const contactReceipt = toolResult.kind === "contact"
        ? `I’ve updated your contact details (${Array.isArray(toolResult.data.updatedFields)
            ? toolResult.data.updatedFields.join(", ") : "provided fields"}).`
        : null;
      const customerReply = contactReceipt ?? safeUnverifiedReply(first.reply ?? "");
      return {
        reply: isLivePhone ? safeLivePhoneReply(customerReply) : customerReply,
        handlingMode: "AI" as const,
        action: first.action,
        toolResult,
      };
    },
  };
}

export const responseOrchestrator = createResponseOrchestrator({
  buildContext: buildConversationContext,
  executeTools: executeOrchestratorTools,
  generate: async (workspaceId, referenceId, messages) => {
    const response = await generateAIWithUsage(workspaceId, referenceId, messages);
    return { text: response.text };
  },
});

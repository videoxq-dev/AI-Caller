import { AppError } from "@/server/http/errors";
import { capabilitiesFromBehaviorSettings } from "@/server/agent/capabilities";
import { logger } from "@/server/observability/logger";
import { buildConversationContext, type OrchestratorContext } from "./context";
import {
  executeOrchestratorTools,
  OrchestratorOutputError,
  orchestratorActionSchema,
  parseOrchestratorEnvelope,
  type OrchestratorEnvelope,
  type OrchestratorToolResult,
} from "./tools";
import { generateAIWithUsage } from "./usage";
import {
  getAwaitingPendingAction,
  isExplicitActionConfirmation,
} from "./pending-actions";
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

const LIVE_PHONE_ESCALATION_REPLY = "I've flagged this issue for our team to follow up. I can't transfer this call live. I can keep helping with anything else.";


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
  getAwaitingAction?: typeof getAwaitingPendingAction;
};

const ACTION_PROTOCOL = `
Return exactly one JSON object and no prose outside it.
Shape:
{
  "reply": "short customer-facing response when no server result is required",
  "contact": { "name": "explicitly provided name", "email": "explicitly provided email", "phone": "explicitly provided phone" },
  "lead": { "status": "NEW|QUALIFIED", "intent": "...", "serviceRequested": "..." },
  "unresolved": { "reason": "why the current request cannot be completed with approved information and enabled capabilities" },
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
- Resolve ordinary relative dates and month/day dates from Current server time in the business timezone. If the month/day has not passed, use the current year; otherwise use the next year. Do not ask for a year when that rule makes the future date unambiguous.
- Use the configured business timezone unless the customer explicitly supplies a different timezone. Do not ask them to reconfirm the configured default. Compare actual dates against Current server time; prior assistant claims about past dates or configuration are not authoritative.
- The built-in appointment calendar does not require Google OAuth or an external calendar connection. Use the calendar tools to determine availability and readiness instead of inferring configuration failures.
- Never say a slot is available unless CHECK_AVAILABILITY returned it. Describe the returned slots and ask the customer to choose and approve one.
- BOOK_APPOINTMENT and SEND_SMS are consequential actions with a server-enforced commit boundary. Gather the required details first. The first complete action proposal is staged and returned as a preview; it is not executed. After the customer explicitly confirms that exact preview, invoke the same action again so the server can commit it.
- Never say an appointment is booked unless BOOK_APPOINTMENT returned a confirmed booking. Never say a staged action has already happened.
- Populate contact fields only when the customer explicitly provided them in the conversation. Never infer or invent contact details.
- A verified customer conversation/contact is sufficient for an in-app appointment; email is optional. Never invent missing contact data.
- Use ESCALATE for an explicit human request, or when the saved When Unsure policy is "Escalate to a human" and you cannot complete the request with the enabled capabilities. ESCALATE creates an issue-specific staff case; it does not transfer ownership of the whole conversation. Continue helping with unrelated supported requests. A disabled capability does not silently hand off by itself: explain the limitation truthfully, and request ESCALATE only when that policy requires it and ESCALATE is enabled. Never claim staff were notified without a successful ESCALATE result.
- If the current customer request cannot be completed with approved information and enabled capabilities, set "unresolved" with a concise reason. Do not use it merely because you need one normal missing detail that the customer can answer.
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
- Omit optional contact, lead and unresolved fields when there is nothing new to record. Keep action at the top level, never inside unresolved. Do not repeat saved contact details in every response.
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

const MONTHS = new Map([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4],
  ["may", 5], ["june", 6], ["july", 7], ["august", 8],
  ["september", 9], ["october", 10], ["november", 11], ["december", 12],
]);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function zonedDateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((row) => row.type === type)?.value ?? NaN);
  return { year: part("year"), month: part("month"), day: part("day"),
    hour: part("hour"), minute: part("minute") };
}

function localDateTimeToInstant(
  input: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
) {
  const target = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  const validDate = new Date(Date.UTC(input.year, input.month - 1, input.day));
  if (validDate.getUTCFullYear() !== input.year || validDate.getUTCMonth() + 1 !== input.month
    || validDate.getUTCDate() !== input.day) return null;
  let instant = target;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = zonedDateTimeParts(new Date(instant), timezone);
      const represented = Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute);
      const delta = target - represented;
      if (delta === 0) break;
      instant += delta;
    }
    const roundTrip = zonedDateTimeParts(new Date(instant), timezone);
    return Object.entries(input).every(([key, value]) =>
      roundTrip[key as keyof typeof roundTrip] === value)
      ? new Date(instant) : null;
  } catch {
    return null;
  }
}

function deterministicAvailabilityPlan(
  message: string,
  timezone: string,
  services: OrchestratorContext["services"] = [],
): OrchestratorEnvelope | null {
  if (!/\b(?:availability|available|openings?|slots?|book|booking|reserve|reservation|schedule|appointment)\b/i.test(message)) return null;
  // Customer messages are newest first. An explicit timezone beats the business
  // default, including a follow-up such as "yes, the zone is UTC".
  const explicitTimezone = /\b(?:[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC|GMT)\b/.exec(message)?.[0];
  if (explicitTimezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: explicitTimezone }).format(); }
    catch { return null; }
    timezone = explicitTimezone;
  }

  const monthNames = [...MONTHS.keys()].join("|");
  const dayFirst = new RegExp(
    `\\b(?:(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\s*,?\\s*(\\d{4})\\b`,
    "i",
  ).exec(message);
  const monthFirst = new RegExp(
    `\\b(?:(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\s+)?(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`,
    "i",
  ).exec(message);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(message);

  let year: number;
  let month: number;
  let day: number;
  let weekday: string | undefined;
  if (dayFirst) {
    weekday = dayFirst[1]?.toLowerCase();
    day = Number(dayFirst[2]);
    month = MONTHS.get(dayFirst[3].toLowerCase()) ?? 0;
    year = Number(dayFirst[4]);
  } else if (monthFirst) {
    weekday = monthFirst[1]?.toLowerCase();
    month = MONTHS.get(monthFirst[2].toLowerCase()) ?? 0;
    day = Number(monthFirst[3]);
    year = Number(monthFirst[4]);
  } else if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  } else {
    return null;
  }

  const time12 = /\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(message);
  const time24 = /\b(?:at|by)\s+([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(message);
  let hour: number;
  let minute: number;
  if (time12) {
    hour = Number(time12[1]);
    minute = Number(time12[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = time12[3].toLowerCase().startsWith("p");
    hour = hour % 12 + (pm ? 12 : 0);
  } else if (time24) {
    hour = Number(time24[1]);
    minute = Number(time24[2]);
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  if (weekday && WEEKDAYS[date.getUTCDay()] !== weekday) return null;

  const startsAt = localDateTimeToInstant({ year, month, day, hour, minute }, timezone);
  if (!startsAt || startsAt.getTime() <= Date.now()) return null;
  const normalizedMessage = message.toLocaleLowerCase("en-US");
  const matchedServices = services.filter((service) =>
    service.name.trim().length >= 2
    && normalizedMessage.includes(service.name.trim().toLocaleLowerCase("en-US")));
  const durationMinutes = matchedServices.length === 1
    && matchedServices[0].durationMinutes
    && matchedServices[0].durationMinutes > 0
    ? matchedServices[0].durationMinutes : undefined;
  const searchMinutes = Math.max(120, durationMinutes ?? 0);
  const endsAt = new Date(startsAt.getTime() + searchMinutes * 60_000);
  return {
    action: {
      type: "CHECK_AVAILABILITY",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timezone,
      ...(durationMinutes ? { durationMinutes } : {}),
    },
  };
}

function recentCustomerBookingText(context: OrchestratorContext) {
  return context.messages
    .filter((message) => message.role === "user")
    .slice(-6)
    .reverse()
    .map((message) => message.content)
    .join("\n");
}

function availabilityRecoveryText(context: OrchestratorContext, latest: string) {
  // Do not replay an earlier availability request after an approval, objection,
  // or unrelated question. Recovery may combine details only while the customer
  // is actually supplying date/time information for the current request.
  const suppliesTiming = /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|UTC|GMT|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\d{1,2}\s*[ap]m)\b|\b[A-Za-z_]+\/[A-Za-z_]+\b/i.test(latest);
  const previousReply = [...context.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
  if (/^I checked the schedule\.|^I have everything needed to book/.test(previousReply)) {
    // The last lookup has already been answered. A selected slot must progress
    // through the planner to BOOK_APPOINTMENT, not replay the original lookup.
    return latest;
  }
  return suppliesTiming ? recentCustomerBookingText(context) : latest;
}

function bookingMissingDetailReply(message: string) {
  if (!/\b(?:book|booking|reserve|reservation|schedule|appointment)\b/i.test(message)) return null;
  const hasDate = /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/i.test(message);
  const hasTime = /\b(?:at|by)\s+(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)?\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/i.test(message);
  if (!hasDate && !hasTime) return "I can help with that. What date and time would you prefer?";
  if (!hasDate) return "I have the time. What date would you like?";
  if (!hasTime) return "I have the date. What time would you prefer?";
  return null;
}

function pendingActionReply(toolResult: OrchestratorToolResult, fallbackTimezone: string) {
  if (toolResult.data.type === "BOOK_APPOINTMENT") {
    const title = typeof toolResult.data.title === "string" ? toolResult.data.title : "appointment";
    const startsAt = typeof toolResult.data.startsAt === "string" ? new Date(toolResult.data.startsAt) : null;
    const timezone = typeof toolResult.data.timezone === "string" ? toolResult.data.timezone : fallbackTimezone;
    const when = startsAt && Number.isFinite(startsAt.getTime())
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(startsAt)
      : "the selected time";
    return `I have everything needed to book your ${title} for ${when} (${timezone}). Would you like me to book it?`;
  }
  if (toolResult.data.type === "SEND_SMS") {
    const text = typeof toolResult.data.text === "string" ? toolResult.data.text : "the prepared message";
    return `I'm ready to send this text: “${text}” Would you like me to send it?`;
  }
  return "I have the action ready. Would you like me to proceed?";
}

function plannerMessages(context: OrchestratorContext): AIMessage[] {
  const resumedInstruction = context.resumedAfterHumanHandoff
    ? `\n\nAUTHORITATIVE CONVERSATION OWNERSHIP: A workspace operator manually returned this conversation from HUMAN to AI. Older requests for a human and prior handoff messages are history, not a current instruction. Handle the customer's latest request with the enabled capabilities. Do not ESCALATE merely because an older message requested a human; apply the saved When Unsure policy only to a genuinely unresolved current request.`
    : "";
  return [
    {
      role: "system",
      content: `${context.systemPrompt}\n\nCurrent server time: ${new Date().toISOString()}\n${actionProtocolFor(context)}${resumedInstruction}`,
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

function repairMessages(
  context: OrchestratorContext,
  invalidText: string,
  error: OrchestratorOutputError,
): AIMessage[] {
  const validation = error.validationIssues.length
    ? error.validationIssues.join("; ")
    : error.message;
  return [
    ...plannerMessages(context),
    { role: "assistant", content: invalidText.slice(0, 12_000) },
    {
      role: "system",
      content: `Your preceding response could not be validated (${validation}). Return the same intended answer as one corrected JSON object matching the protocol. Use null only where the protocol explicitly permits it. Do not add prose outside the JSON object.`,
    },
  ];
}

function resumedTurnCorrectionMessages(
  context: OrchestratorContext,
  stalePlan: OrchestratorEnvelope,
  latestUserMessage: string,
): AIMessage[] {
  return [
    ...plannerMessages(context),
    { role: "assistant", content: JSON.stringify(stalePlan) },
    {
      role: "system",
      content: `The preceding plan appears to carry forward the old human handoff instead of serving the current turn. The workspace operator has explicitly returned this thread to AI. Re-plan the latest customer request now: ${JSON.stringify(latestUserMessage)}. Preserve useful factual context from history, but do not treat old human requests or handoff messages as current intent. If the latest request can be answered or completed with enabled capabilities, do that now. Use unresolved/ESCALATE only if this latest request is genuinely unresolved under the saved When Unsure policy.`,
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
  if (/\b(?:i(?:['’]ll| will| can)|we(?:['’]ll| will| can)|let me)\s+[^.!?]{0,55}\b(?:connect|transfer|put you through|patch you through)\b[^.!?]{0,75}\b(?:team|staff|human|operator|person|representative|someone|you)\b/i.test(reply)) {
    return "I can't transfer this call live. I'm still handling this conversation and can continue helping here.";
  }
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
      const recentBookingText = recentCustomerBookingText(context);
      const recoveryText = availabilityRecoveryText(context, lastUserMessage);
      const allowed = context.agent
        ? capabilitiesFromBehaviorSettings(context.agent.behaviorSettings)
        : null;
      const whenUnsure = context.agent?.whenUnsure?.trim() || "Escalate to a human";

      const unresolvedWithoutHandoff = (reply: string) => ({
        reply,
        handlingMode: "AI" as const,
        action: { type: "NONE" as const },
        toolResult: { kind: "none" as const, data: {} },
      });

      const resolveUncertainRequest = async (reply: string, reason: string) => {
        if (!context.agent || whenUnsure !== "Escalate to a human") {
          return unresolvedWithoutHandoff(reply);
        }
        if (!allowed?.ESCALATE) {
          return unresolvedWithoutHandoff(
            `${reply} I can't arrange staff follow-up from this conversation right now.`,
          );
        }
        const escalationAction = { type: "ESCALATE" as const, reason };
        if (options.beforeTools && !(await options.beforeTools())) {
          return { reply: null, handlingMode: "AI" as const,
            action: { type: "NONE" as const },
            toolResult: { kind: "none" as const, data: {} } };
        }
        try {
          const escalation = await dependencies.executeTools(
            workspaceId, conversationId, context.contact.id, { action: escalationAction },
          );
          if (escalation.kind !== "escalation") {
            logger.error({ workspaceId, conversationId, reason },
              "When Unsure escalation did not return an escalation receipt");
            return unresolvedWithoutHandoff(
              `${reply} I couldn't arrange staff follow-up. Please contact the business directly.`,
            );
          }
          const receipt = isLivePhone
            ? LIVE_PHONE_ESCALATION_REPLY
            : "I've flagged this issue for staff follow-up. I can keep helping with anything else here.";
          return {
            reply: `${reply} ${receipt}`,
            handlingMode: "AI" as const,
            action: escalationAction,
            toolResult: escalation,
          };
        } catch (error) {
          if (error instanceof AppError && [
            "AGENT_ACTION_DISABLED", "AGENT_NOT_ACTIVE", "AGENT_NOT_CONFIGURED",
            "CONVERSATION_HUMAN_HANDLING",
          ].includes(error.code)) {
            return unresolvedWithoutHandoff(
              `${reply} I couldn't arrange staff follow-up. Please contact the business directly.`,
            );
          }
          throw error;
        }
      };
      const awaitingAction = dependencies.getAwaitingAction
        ? await dependencies.getAwaitingAction(workspaceId, conversationId)
        : null;
      if (awaitingAction && isExplicitActionConfirmation(lastUserMessage)) {
        const parsedAction = orchestratorActionSchema.safeParse({
          type: awaitingAction.type,
          ...awaitingAction.payload,
        });
        if (!parsedAction.success) {
          logger.error(
            { workspaceId, conversationId, pendingActionId: awaitingAction.id },
            "Stored pending action could not be validated",
          );
          return unresolvedWithoutHandoff(
            "I couldn't safely complete the prepared action. Please tell me what you'd like to do again.",
          );
        }
        if (options.beforeTools && !(await options.beforeTools())) {
          return unresolvedWithoutHandoff(
            "I won't complete that action because your request changed. Please confirm the latest details.",
          );
        }
        try {
          const committed = await dependencies.executeTools(
            workspaceId,
            conversationId,
            context.contact.id,
            { action: parsedAction.data },
          );
          if (committed.kind === "booking") {
            return {
              reply: bookingFallback(committed),
              handlingMode: "AI" as const,
              action: parsedAction.data,
              toolResult: committed,
            };
          }
          if (committed.kind === "sms") {
            return {
              reply: committed.data.sent === true
                ? "I have sent the requested text message."
                : String(committed.data.reason ?? "I could not send that text message."),
              handlingMode: "AI" as const,
              action: parsedAction.data,
              toolResult: committed,
            };
          }
          if (committed.kind === "pending_action") {
            return {
              reply: pendingActionReply(committed, context.timezone ?? "UTC"),
              handlingMode: "AI" as const,
              action: parsedAction.data,
              toolResult: committed,
            };
          }
          logger.error(
            { workspaceId, conversationId, pendingActionId: awaitingAction.id, kind: committed.kind },
            "Confirmed pending action returned an unexpected tool result",
          );
          return unresolvedWithoutHandoff(
            "I couldn't safely complete the prepared action. Please tell me what you'd like to do again.",
          );
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          const truthful = approvedToolFailure(parsedAction.data.type, error);
          return resolveUncertainRequest(truthful, `${parsedAction.data.type} failed: ${error.code}`);
        }
      }

      if (awaitingAction) {
        context.systemPrompt += `\nSERVER PENDING ACTION (not executed): ${JSON.stringify({
          type: awaitingAction.type, ...awaitingAction.payload,
        })}. Ask only for approval of these details. If the customer changes them, propose the corrected action for a new preview. Do not restart availability merely because approval is still needed.`;
      }

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
          return { reply: LIVE_PHONE_ESCALATION_REPLY, handlingMode: "AI" as const, action, toolResult };
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
      let planned: OrchestratorEnvelope;
      try {
        planned = parseOrchestratorEnvelope(firstResponse.text);
      } catch (error) {
        if (!(error instanceof OrchestratorOutputError)) throw error;
        logger.warn({ workspaceId, conversationId, validationIssues: error.validationIssues },
          "AI provider returned invalid orchestration output; requesting one correction");
        try {
          const repaired = await dependencies.generate(
            workspaceId, conversationId, repairMessages(context, firstResponse.text, error),
          );
          planned = parseOrchestratorEnvelope(repaired.text);
        } catch (repairError) {
          if (!(repairError instanceof OrchestratorOutputError)) throw repairError;
          logger.error({ workspaceId, conversationId, validationIssues: repairError.validationIssues },
            "AI provider returned invalid orchestration output after correction");
          const deterministic = !awaitingAction && (!allowed || allowed.CHECK_AVAILABILITY)
            ? deterministicAvailabilityPlan(
              recoveryText, context.timezone ?? "UTC", context.services,
            )
            : null;
          if (!deterministic) {
            return unresolvedWithoutHandoff(
              "I couldn't safely interpret that. Please restate your request, including any service, date, or time details that matter.",
            );
          }
          logger.warn({ workspaceId, conversationId, action: deterministic.action.type },
            "Using deterministic recovery for an explicit availability request");
          planned = deterministic;
        }
      }
      if (context.resumedAfterHumanHandoff
        && !isExplicitHumanRequest(lastUserMessage)
        && (planned.action.type === "ESCALATE" || Boolean(planned.unresolved?.reason))) {
        logger.warn({ workspaceId, conversationId, action: planned.action.type },
          "Returned-to-AI turn carried stale handoff intent; requesting a current-turn replan");
        try {
          const resumed = await dependencies.generate(
            workspaceId,
            conversationId,
            resumedTurnCorrectionMessages(context, planned, lastUserMessage),
          );
          planned = parseOrchestratorEnvelope(resumed.text);
        } catch (resumeError) {
          if (!(resumeError instanceof OrchestratorOutputError)) throw resumeError;
          logger.error({ workspaceId, conversationId, validationIssues: resumeError.validationIssues },
            "Returned-to-AI replan was invalid; keeping conversation with AI");
          return unresolvedWithoutHandoff(
            "I'm still handling this conversation. Please restate your current request and I'll continue from here.",
          );
        }
      }

      // A normal missing booking detail is not uncertainty and must never trigger
      // staff escalation. The server owns this distinction even if the model
      // incorrectly labels the incomplete request as unresolved.
      const plannedLooksUnresolved = planned.action.type === "ESCALATE"
        || Boolean(planned.unresolved?.reason);
      const bookingClarification = bookingMissingDetailReply(recentBookingText);
      const bookingCanProceed = !allowed || allowed.BOOK_APPOINTMENT;
      const bookingAvailabilityRecovery = plannedLooksUnresolved
        && !awaitingAction
        && bookingCanProceed
        && (!allowed || allowed.CHECK_AVAILABILITY)
        ? deterministicAvailabilityPlan(
            recoveryText,
            context.timezone ?? "UTC",
            context.services,
          )
        : null;
      if (bookingAvailabilityRecovery) {
        logger.warn(
          { workspaceId, conversationId, plannedAction: planned.action.type },
          "Replacing unresolved booking plan with authoritative availability check",
        );
        planned = bookingAvailabilityRecovery;
      } else if (bookingCanProceed && bookingClarification && plannedLooksUnresolved) {
        return unresolvedWithoutHandoff(bookingClarification);
      }

      // Capability denials are resolved together with the saved When Unsure policy.
      if (planned.action.type === "NONE" && planned.unresolved?.reason) {
        const reply = planned.reply
          ?? "I can't complete that request with the information and capabilities available right now.";
        return resolveUncertainRequest(reply, planned.unresolved.reason);
      }

      // If the model recognizes that an owner-disabled capability blocks the
      // request, the server—not the model—decides whether When Unsure authorizes
      // a real handoff. This keeps refusal text and ownership state consistent.
      if (planned.action.type === "ESCALATE" && allowed
        && !isExplicitHumanRequest(lastUserMessage)) {
        const wantsAvailability = /\b(?:available|availability|open slots?|check times?)\b/i.test(lastUserMessage);
        const wantsBooking = /\b(?:book|booking|reserve|appointment|schedule)\b/i.test(recentBookingText);
        if ((wantsAvailability && !allowed.CHECK_AVAILABILITY)
          || (wantsBooking && !allowed.BOOK_APPOINTMENT)) {
          const reply = wantsAvailability
            ? "I can't check live appointment availability at the moment. No time has been reserved."
            : "I can't book an appointment right now. Nothing has been booked.";
          return resolveUncertainRequest(reply,
            `Requested ${wantsAvailability ? "availability check" : "appointment booking"} is disabled; applying When Unsure policy.`);
        }
      }
      if (planned.action.type === "ESCALATE" && !isExplicitHumanRequest(lastUserMessage)) {
        if (planned.unresolved?.reason) {
          const reply = planned.reply
            ?? "I can't complete that request with the information and capabilities available right now.";
          return resolveUncertainRequest(reply, planned.unresolved.reason);
        }
        // A model-proposed handoff is not authority by itself. In particular,
        // prior human requests in the transcript must not re-escalate a thread
        // after an owner explicitly returns it to AI.
        const reply = whenUnsure === "Ask a clarifying question"
          ? "I’m not certain I can complete that request yet. Could you clarify what you need?"
          : whenUnsure === "Collect details for follow-up"
            ? "I can collect the details needed for follow-up. What name and contact information should I record?"
            : safeUnverifiedReply(planned.reply ?? "How can I help with your current request?");
        return unresolvedWithoutHandoff(reply);
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
        if (error instanceof AppError && error.code === "AGENT_ACTION_DISABLED") {
          if (first.action.type === "ESCALATE") {
            return unresolvedWithoutHandoff(
              "I can't arrange staff follow-up from this conversation right now. Please contact the business directly.",
            );
          }
          return resolveUncertainRequest(
            approvedToolFailure(first.action.type, error),
            `Requested ${first.action.type} is disabled; applying When Unsure policy.`,
          );
        }
        if (error instanceof AppError && [
          "BUSINESS_HOURS_NOT_CONFIGURED", "CALENDAR_CONFIG_INVALID", "CALENDAR_NOT_CONFIGURED", "NATIVE_BOOKING_UNAVAILABLE",
        ].includes(error.code)) {
          return resolveUncertainRequest(
            approvedToolFailure(first.action.type, error),
            `Unable to complete ${first.action.type}; applying When Unsure policy.`,
          );
        }
        if (error instanceof AppError && [
          "APPOINTMENT_SLOT_UNAVAILABLE", "APPOINTMENT_OUTSIDE_HOURS",
          "APPOINTMENT_IN_PAST", "APPOINTMENT_DAILY_LIMIT_REACHED", "AVAILABILITY_RANGE_INVALID",
        ].includes(error.code)) {
          return unresolvedWithoutHandoff(approvedToolFailure(first.action.type, error));
        }
        throw error;
      }

      if (toolResult.kind === "pending_action") {
        return {
          reply: pendingActionReply(toolResult, context.timezone ?? "UTC"),
          handlingMode: "AI" as const,
          action: first.action,
          toolResult,
        };
      }

      if (toolResult.kind === "availability") {
        // Present verified calendar slots directly, not a second model's
        // possible assertion that it never checked or an invented opening.
        const availabilityTimezone = typeof toolResult.data.timezone === "string"
          ? toolResult.data.timezone : context.timezone ?? "UTC";
        return { reply: availabilityReply(toolResult, availabilityTimezone),
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
            : "I've flagged this issue for staff follow-up. I can keep helping with anything else here.",
          handlingMode: "AI" as const,
          action: first.action,
          toolResult,
        };
      }

      if (!first.reply && toolResult.kind !== "contact") throw new Error("AI provider did not return a customer-facing response.");
      const contactReceipt = toolResult.kind === "contact"
        ? `I’ve updated your contact details (${Array.isArray(toolResult.data.updatedFields)
            ? toolResult.data.updatedFields.join(", ") : "provided fields"}).`
        : null;
      const substantiveReply = safeUnverifiedReply(first.reply ?? "");
      const customerReply = contactReceipt
        ? [contactReceipt, substantiveReply].filter(Boolean).join(" ")
        : substantiveReply;
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
  getAwaitingAction: getAwaitingPendingAction,
});

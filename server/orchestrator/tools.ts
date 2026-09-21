import { escalateConversation } from "@/server/collaboration/service";
import { assertAgentActionAllowed } from "@/server/agent/capabilities";
import { requireActiveWorkspaceAgent } from "@/server/agent/service";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { recordSmsConsent } from "@/server/sms/consent";
import { resolveSmsRuntimeForWorkspace } from "@/server/providers/sms/runtime";
import { sendSmsConversationTextWithRuntime } from "@/server/sms/outbound";
import { z } from "zod";
import { evaluateQualification, getQualificationConfig } from "./qualification";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { updateContactProfile } from "@/server/domain/core/contact-profile";
import { getActiveConversationChannel, type ConversationChannel } from "@/server/domain/core/conversation-channels";
import {
  appendMessage,
  getConversationById,
  getContactDetail,
  upsertLead,
} from "@/server/domain/core/repository";

const optionalShortText = z.string().trim().min(1).max(1000).nullable().optional();
const timezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Timezone must be a valid IANA timezone.");

export const orchestratorActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NONE") }),
  z.object({
    type: z.literal("RECORD_SMS_CONSENT"),
    category: z.enum(["TRANSACTIONAL", "MARKETING", "ALL"]),
    status: z.enum(["OPTED_IN", "OPTED_OUT"]),
  }),
  z.object({
    type: z.literal("SEND_SMS"),
    text: z.string().trim().min(1).max(1600),
  }),
  z.object({
    type: z.literal("CHECK_AVAILABILITY"),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    timezone: timezoneSchema,
    durationMinutes: z.number().int().min(5).max(480).optional(),
  }),
  z.object({
    type: z.literal("BOOK_APPOINTMENT"),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    timezone: timezoneSchema,
    title: z.string().trim().min(1).max(500),
    serviceId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  }),
  z.object({
    type: z.literal("QUALIFY_LEAD"),
    answers: z.array(z.object({
      criterionId: z.string().trim().regex(/^[a-z0-9_-]{1,64}$/),
      answer: z.string().trim().min(1).max(2000),
    })).min(1).max(10),
  }),
  z.object({
    type: z.literal("ESCALATE"),
    reason: z.string().trim().min(1).max(1000).optional(),
  }),
]).superRefine((action, ctx) => {
  if (action.type !== "CHECK_AVAILABILITY" && action.type !== "BOOK_APPOINTMENT") return;
  if (new Date(action.endsAt).getTime() <= new Date(action.startsAt).getTime()) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt." });
  }
});

export const orchestratorEnvelopeSchema = z.object({
  reply: z.string().trim().min(1).max(5000).optional(),
  contact: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()).optional(),
    phone: z.string().trim().min(1).max(50).optional(),
  }).optional(),
  lead: z.object({
    status: z.enum(["NEW", "QUALIFIED"]).optional(),
    intent: optionalShortText,
    serviceRequested: z.string().trim().min(1).max(500).nullable().optional(),
  }).optional(),
  action: orchestratorActionSchema.default({ type: "NONE" }),
});

export type OrchestratorEnvelope = z.infer<typeof orchestratorEnvelopeSchema>;
export type OrchestratorToolResult = {
  kind: "none" | "contact" | "qualification" | "availability" | "booking" | "escalation" | "consent" | "sms";
  data: Record<string, unknown>;
};

type LeadStatus = "NEW" | "QUALIFIED" | "BOOKED" | "WON" | "LOST";

function extractJson(text: string) {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

export function parseOrchestratorEnvelope(text: string): OrchestratorEnvelope {
  const json = extractJson(text);
  if (json) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(json);
    } catch {
      throw new Error("AI provider returned malformed orchestration JSON.");
    }
    const parsed = orchestratorEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("AI provider returned an invalid orchestration action.");
    return parsed.data;
  }

  const reply = text.trim();
  if (!reply) throw new Error("AI provider returned an empty orchestration response.");
  return { reply: reply.slice(0, 5000), action: { type: "NONE" } };
}

function qualificationStatus(
  existingStatus: LeadStatus | undefined,
  requestedStatus: "NEW" | "QUALIFIED" | undefined,
): LeadStatus {
  if (existingStatus === "BOOKED" || existingStatus === "WON" || existingStatus === "LOST") return existingStatus;
  if (existingStatus === "QUALIFIED" && requestedStatus === "NEW") return "QUALIFIED";
  return requestedStatus ?? existingStatus ?? "NEW";
}

async function updateLeadFromEnvelope(
  workspaceId: string,
  contactId: string,
  lead: NonNullable<OrchestratorEnvelope["lead"]>,
  channel: ConversationChannel,
) {
  const detail = await getContactDetail(workspaceId, contactId);
  if (!detail) throw new Error("The conversation contact no longer exists.");
  const existing = detail.lead;
  return upsertLead(workspaceId, contactId, {
    status: qualificationStatus(existing?.status, lead.status === "QUALIFIED" ? undefined : lead.status),
    intent: lead.intent !== undefined ? lead.intent : existing?.intent ?? null,
    serviceRequested: lead.serviceRequested !== undefined ? lead.serviceRequested : existing?.serviceRequested ?? null,
    source: existing?.source ?? channel,
    estimatedValue: existing?.estimatedValue ?? null,
    assignedUserId: existing?.assignedUserId ?? null,
  });
}

async function verifyVoiceConsent(
  workspaceId: string,
  conversationId: string,
  category: "TRANSACTIONAL" | "MARKETING" | "ALL",
  status: "OPTED_IN" | "OPTED_OUT",
) {
  const history = await db.select().from(messages).where(and(
    eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId),
    eq(messages.channel, "PHONE"), eq(messages.contentType, "CALL_TRANSCRIPT"),
  )).orderBy(desc(messages.createdAt)).limit(8);
  const customer = history.find((row) => row.senderType === "CUSTOMER");
  if (!customer) throw new AppError("SMS_CONSENT_EVIDENCE_REQUIRED", "No customer consent statement was found in the call.", 409);
  const statement = customer.body.trim().toLowerCase();
  if (status === "OPTED_OUT") {
    if (!/\b(stop|unsubscribe|do not|don't|no longer|opt out|remove me)\b/i.test(statement)) {
      throw new AppError("SMS_CONSENT_EVIDENCE_REQUIRED", "An explicit customer opt-out is required.", 409);
    }
    return { customer, consentStatement: customer.body };
  }
  if (!/^(yes|yeah|yep|sure|okay|ok|i agree|i do|please|absolutely|that would be great|sounds good)\b/i.test(statement) ||
      /\b(no|don't|do not|not|never)\b/i.test(statement)) {
    throw new AppError("SMS_CONSENT_EVIDENCE_REQUIRED", "The customer has not explicitly agreed to SMS messages.", 409);
  }
  const preceding = history.filter((row) => row.senderType === "AI" && row.createdAt <= customer.createdAt);
  const question = preceding[0]?.body ?? "";
  const mentionsSms = /\b(text|sms|text messages?)\b/i.test(question);
  const mentionsCategory = category === "TRANSACTIONAL"
    ? /\b(appointment|confirmation|reminder|updates|reschedul)\w*/i.test(question)
    : /\b(marketing|offer|promotion|discount)\w*/i.test(question);
  if (!mentionsSms || !mentionsCategory) {
    throw new AppError("SMS_CONSENT_EVIDENCE_REQUIRED", "Ask the customer explicitly about this SMS program before recording consent.", 409);
  }
  return { customer, consentStatement: question + " Customer: " + customer.body };
}

export async function executeOrchestratorTools(
  workspaceId: string,
  conversationId: string,
  contactId: string,
  envelope: OrchestratorEnvelope,
): Promise<OrchestratorToolResult> {
  // Re-read the current policy at the execution boundary; the model and its prompt are untrusted.
  const agent = await requireActiveWorkspaceAgent(workspaceId, "ANSWER_INQUIRY");
  if (envelope.contact) assertAgentActionAllowed(agent.capabilities, "UPDATE_CONTACT");
  if (envelope.lead) assertAgentActionAllowed(agent.capabilities, "UPDATE_LEAD");
  if (envelope.lead?.status === "QUALIFIED") assertAgentActionAllowed(agent.capabilities, "QUALIFY_LEAD");
  if (envelope.action.type !== "NONE") {
    // Revocation must remain available even when new opt-ins have been disabled.
    if (!(envelope.action.type === "RECORD_SMS_CONSENT" && envelope.action.status === "OPTED_OUT")) {
      assertAgentActionAllowed(agent.capabilities, envelope.action.type);
    }
  }
  const currentConversation = await getConversationById(workspaceId, conversationId);
  if (!currentConversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
  if (currentConversation.handlingMode === "HUMAN") {
    throw new AppError("CONVERSATION_HUMAN_HANDLING", "Staff now controls this conversation.", 409);
  }
  const channel = await getActiveConversationChannel(workspaceId, conversationId) ?? "WEBCHAT";
  const needsQualificationConfig = envelope.action.type === "QUALIFY_LEAD" || envelope.lead?.status === "QUALIFIED";
  const qualificationConfig = needsQualificationConfig ? await getQualificationConfig(workspaceId) : null;
  const updatedContact = envelope.contact
    ? await updateContactProfile(workspaceId, contactId, envelope.contact) : null;
  if (envelope.lead) {
    await updateLeadFromEnvelope(
      workspaceId,
      contactId,
      envelope.lead,
      channel,
    );
  }

  if (envelope.action.type === "NONE") return updatedContact
    ? { kind: "contact", data: {
        contactId: updatedContact.id,
        updatedFields: Object.keys(envelope.contact ?? {}),
      } }
    : { kind: "none", data: {} };

  if (envelope.action.type === "RECORD_SMS_CONSENT") {
    if (channel !== "PHONE") {
      throw new AppError("SMS_CONSENT_CHANNEL_UNSUPPORTED", "Use the consent form or verified SMS keyword for this channel.", 409);
    }
    const detail = await getContactDetail(workspaceId, contactId);
    if (!detail?.phone) throw new AppError("SMS_PHONE_REQUIRED", "Collect the customer's phone number first.", 409);
    const evidence = await verifyVoiceConsent(
      workspaceId, conversationId, envelope.action.category, envelope.action.status,
    );
    if (envelope.action.category === "ALL" && envelope.action.status !== "OPTED_OUT")
      throw new AppError("SMS_CONSENT_CATEGORY_REQUIRED", "Choose an individual messaging category for opt-in.", 409);
    const categories = envelope.action.category === "ALL"
      ? ["TRANSACTIONAL", "MARKETING"] as const : [envelope.action.category];
    for (const category of categories) {
      await recordSmsConsent(workspaceId, contactId, detail.phone, {
        category, status: envelope.action.status,
        source: "AI_CALL", sourceReference: evidence.customer.id,
        consentStatement: evidence.consentStatement,
      });
    }
    return { kind: "consent", data: { category: envelope.action.category, status: envelope.action.status } };
  }

  if (envelope.action.type === "SEND_SMS") {
    // SMS-channel replies already travel through the webhook worker. A tool invocation
    // there would generate a second outbound message for the same inbound event.
    if (channel === "SMS") throw new AppError("SMS_TOOL_UNAVAILABLE_IN_SMS", "Reply normally to the inbound SMS instead.", 409);
    const detail = await getContactDetail(workspaceId, contactId);
    if (!detail?.phone) return { kind: "sms", data: { sent: false, reason: "Customer phone number is missing." } };
    const runtime = await resolveSmsRuntimeForWorkspace(workspaceId);
    try {
      const message = await sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime, {
        senderType: "AI", text: envelope.action.text, to: detail.phone,
        metadata: { source: "ORCHESTRATOR" },
      });
      return { kind: "sms", data: { sent: true, messageId: message.id, status: message.status } };
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        return { kind: "sms", data: { sent: false, reason: error.message } };
      }
      throw error;
    }
  }

  if (envelope.action.type === "QUALIFY_LEAD") {
    if (!qualificationConfig?.enabled || !qualificationConfig.criteria.length) {
      throw new Error("Lead qualification is not configured for this workspace.");
    }
    const detail = await getContactDetail(workspaceId, contactId);
    if (!detail) throw new Error("The conversation contact no longer exists.");
    const result = evaluateQualification(
      qualificationConfig,
      detail.lead?.qualificationData,
      envelope.action.answers,
    );
    const existing = detail.lead;
    await upsertLead(workspaceId, contactId, {
      status: qualificationStatus(existing?.status, result.qualified ? "QUALIFIED" : undefined),
      intent: existing?.intent ?? null,
      serviceRequested: existing?.serviceRequested ?? null,
      source: existing?.source ?? channel,
      estimatedValue: existing?.estimatedValue ?? null,
      assignedUserId: existing?.assignedUserId ?? null,
      qualificationData: result.answers,
      qualificationScore: result.score,
      qualificationCompletedAt: result.qualified ? existing?.qualificationCompletedAt ?? new Date() : null,
    });
    return {
      kind: "qualification",
      data: {
        qualified: result.qualified,
        score: result.score,
        answers: result.answers,
        missingRequired: result.missingRequired,
      },
    };
  }

  if (envelope.action.type === "CHECK_AVAILABILITY") {
    const slots = await calendarBookingService.getAvailability(workspaceId, {
      startsAt: new Date(envelope.action.startsAt),
      endsAt: new Date(envelope.action.endsAt),
      timezone: envelope.action.timezone,
      durationMinutes: envelope.action.durationMinutes,
    });
    return {
      kind: "availability",
      data: {
        slots: slots.slice(0, 12).map((slot) => ({
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
        })),
      },
    };
  }

  if (envelope.action.type === "BOOK_APPOINTMENT") {
    const detail = await getContactDetail(workspaceId, contactId);
    if (!detail) throw new Error("The conversation contact no longer exists.");
    const appointment = await calendarBookingService.book(workspaceId, {
      contactId,
      conversationId,
      serviceId: envelope.action.serviceId ?? null,
      title: envelope.action.title,
      startsAt: new Date(envelope.action.startsAt),
      endsAt: new Date(envelope.action.endsAt),
      timezone: envelope.action.timezone,
      bookingSource: `${channel}_AI`,
      notes: envelope.action.notes ?? null,
      attendeeName: detail.name,
      attendeeEmail: detail.email,
    });

    const existingLead = detail.lead;
    await upsertLead(workspaceId, contactId, {
      status: "BOOKED",
      intent: existingLead?.intent ?? "Appointment booking",
      serviceRequested: existingLead?.serviceRequested ?? envelope.action.title,
      source: existingLead?.source ?? channel,
      estimatedValue: existingLead?.estimatedValue ?? null,
      assignedUserId: existingLead?.assignedUserId ?? null,
    });
    await appendMessage(workspaceId, conversationId, {
      channel,
      direction: "INTERNAL",
      senderType: "SYSTEM",
      contentType: "APPOINTMENT_EVENT",
      body: `Appointment booked: ${envelope.action.title}`,
      provider: null,
      externalMessageId: null,
      status: "CONFIRMED",
      metadata: { appointmentId: appointment.id, startsAt: appointment.startsAt.toISOString() },
    });

    return {
      kind: "booking",
      data: {
        appointmentId: appointment.id,
        title: envelope.action.title,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        timezone: appointment.timezone,
        status: appointment.status,
      },
    };
  }

  const conversation = await escalateConversation({
    workspaceId,
    conversationId,
    reason: envelope.action.reason ?? null,
  });
  await appendMessage(workspaceId, conversationId, {
    channel,
    direction: "INTERNAL",
    senderType: "SYSTEM",
    contentType: "SYSTEM_EVENT",
    body: envelope.action.reason ? `AI escalated to a human: ${envelope.action.reason}` : "AI escalated to a human.",
    provider: null,
    externalMessageId: null,
    status: null,
    metadata: { handlingMode: conversation.handlingMode },
  });
  return { kind: "escalation", data: { handlingMode: "HUMAN", reason: envelope.action.reason ?? null } };
}

import { z } from "zod";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { updateContactProfile } from "@/server/domain/core/contact-profile";
import { getActiveConversationChannel, type ConversationChannel } from "@/server/domain/core/conversation-channels";
import {
  appendMessage,
  getContactDetail,
  setConversationHandlingMode,
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
  kind: "none" | "qualification" | "availability" | "booking" | "escalation";
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
    status: qualificationStatus(existing?.status, qualificationEnabled && lead.status === "QUALIFIED" ? undefined : lead.status),
    intent: lead.intent !== undefined ? lead.intent : existing?.intent ?? null,
    serviceRequested: lead.serviceRequested !== undefined ? lead.serviceRequested : existing?.serviceRequested ?? null,
    source: existing?.source ?? channel,
    estimatedValue: existing?.estimatedValue ?? null,
    assignedUserId: existing?.assignedUserId ?? null,
  });
}

export async function executeOrchestratorTools(
  workspaceId: string,
  conversationId: string,
  contactId: string,
  envelope: OrchestratorEnvelope,
): Promise<OrchestratorToolResult> {
  const channel = await getActiveConversationChannel(workspaceId, conversationId) ?? "WEBCHAT";
  const needsQualificationConfig = envelope.action.type === "QUALIFY_LEAD" || envelope.lead?.status === "QUALIFIED";
  const qualificationConfig = needsQualificationConfig ? await getQualificationConfig(workspaceId) : null;
  if (envelope.contact) await updateContactProfile(workspaceId, contactId, envelope.contact);
  if (envelope.lead) {
    await updateLeadFromEnvelope(
      workspaceId,
      contactId,
      envelope.lead,
      channel,
      Boolean(qualificationConfig?.enabled && qualificationConfig.criteria.length),
    );
  }

  if (envelope.action.type === "NONE") return { kind: "none", data: {} };

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

  const conversation = await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
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

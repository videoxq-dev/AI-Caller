import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contactIdentities, conversations, hostedPhoneNumbers, messages, smsRegistrations, usageEvents } from "@/db/schema";
import { analyzeSmsSegments } from "@/server/billing/sms-segments";
import { loadHostedRateSnapshot, quoteHostedUsage } from "@/server/billing/pricing";
import {
  releaseCreditReservation,
  reserveCredits,
  settleCreditReservation,
} from "@/server/credits/service";
import { appendMessage } from "@/server/domain/core/repository";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { ProviderRequestError } from "@/server/providers/http";
import { outboundSmsReady } from "@/server/phone-numbers/lifecycle";
import { resolveSmsRuntimeForWorkspace, type SmsRuntime } from "@/server/providers/sms/runtime";
import { attachSmsProviderMessage, markSmsSendFailure } from "./repository";
import { classifySmsPurpose } from "./classification";
import { consentAllowsSend, getSmsConsentStatus } from "./consent";
import { validateApprovedSmsMessage, type ApprovedSmsPolicy, type SmsPurpose } from "./policy";

const MAX_SMS_TEXT_CHARACTERS = 1600;

function smsText(value: string) {
  const text = value.trim();
  if (!text) throw new AppError("EMPTY_SMS_MESSAGE", "SMS message cannot be empty.", 400);
  const characters = Array.from(text);
  if (characters.length <= MAX_SMS_TEXT_CHARACTERS) return text;
  return `${characters.slice(0, MAX_SMS_TEXT_CHARACTERS - 1).join("")}…`;
}

function statusCallbackUrl(provider: string, workspaceId: string) {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/api/webhooks/sms/${provider}/${workspaceId}`;
}

function uncertainProviderFailure(error: unknown) {
  return !(error instanceof ProviderRequestError) || error.status >= 500;
}

function definitiveProviderRejection(error: unknown) {
  return error instanceof ProviderRequestError && error.status >= 400 && error.status < 500;
}

type HostedSmsCharge = {
  reservation: Awaited<ReturnType<typeof reserveCredits>>;
  quote: ReturnType<typeof quoteHostedUsage>;
};

async function reserveHostedCredits(
  workspaceId: string,
  runtime: SmsRuntime,
  messageId: string,
  segments: number,
): Promise<HostedSmsCharge | null> {
  if (runtime.mode !== "HOSTED") return null;
  const rates = await loadHostedRateSnapshot({
    capability: "SMS",
    provider: runtime.providerName,
    model: "",
    units: ["SMS_SEGMENT"],
  });
  const quote = quoteHostedUsage(rates, [{ unit: "SMS_SEGMENT", units: segments }]);
  if (quote.credits <= 0) throw new Error("Hosted SMS reservation must be positive.");
  const reservation = await reserveCredits(workspaceId, quote.credits, {
    referenceType: "SMS_RESERVATION",
    referenceId: messageId,
  });
  return { reservation, quote };
}

async function settleHostedCredits(
  workspaceId: string,
  charge: HostedSmsCharge | null,
  messageId: string,
) {
  if (!charge) return;
  await settleCreditReservation(workspaceId, charge.reservation.id, charge.quote.credits, {
    reason: "Hosted SMS message",
    referenceType: "SMS_MESSAGE",
    referenceId: messageId,
  });
}

async function releaseHostedCredits(
  workspaceId: string,
  charge: HostedSmsCharge | null,
) {
  if (!charge) return;
  await releaseCreditReservation(workspaceId, charge.reservation.id);
}

async function recordUsage(
  workspaceId: string,
  runtime: SmsRuntime,
  referenceId: string,
  charge: HostedSmsCharge | null,
  providerUsage: Record<string, unknown>,
) {
  try {
    await db.insert(usageEvents).values({
      workspaceId,
      capability: "SMS",
      provider: runtime.providerName,
      mode: runtime.mode,
      providerUsage,
      creditsCharged: charge?.quote.credits ?? 0,
      providerCostMicros: charge?.quote.providerCostMicros ?? 0,
      billedUnits: charge?.quote.billedUnits ?? {},
      pricingDetails: charge?.quote.pricingDetails ?? {},
      referenceType: "MESSAGE",
      referenceId,
    });
  } catch (error) {
    logger.error({ err: error, workspaceId, provider: runtime.providerName, referenceId }, "Failed to persist SMS usage event");
  }
}

async function conversationState(workspaceId: string, conversationId: string) {
  const [conversation] = await db.select().from(conversations).where(and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.id, conversationId),
  )).limit(1);
  if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
  return conversation;
}

async function destination(workspaceId: string, conversationId: string) {
  const [identity] = await db.select({ value: contactIdentities.normalizedValue })
    .from(conversations)
    .innerJoin(contactIdentities, and(
      eq(contactIdentities.workspaceId, workspaceId),
      eq(contactIdentities.contactId, conversations.contactId),
      eq(contactIdentities.channel, "SMS"),
    ))
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .limit(1);
  if (!identity) throw new AppError("SMS_IDENTITY_NOT_FOUND", "This conversation does not have an SMS identity.", 409);
  return identity.value;
}

async function managedSmsPolicy(workspaceId: string, senderNumber: string) {
  const [row] = await db.select({
    readiness: hostedPhoneNumbers.messagingReadiness,
    registrationStatus: smsRegistrations.status,
    policy: smsRegistrations.approvedPolicy,
  }).from(hostedPhoneNumbers)
    .leftJoin(smsRegistrations, and(
      eq(smsRegistrations.workspaceId, hostedPhoneNumbers.workspaceId),
      eq(smsRegistrations.phoneNumberId, hostedPhoneNumbers.id),
    ))
    .where(and(
      eq(hostedPhoneNumbers.workspaceId, workspaceId),
      eq(hostedPhoneNumbers.phoneNumber, senderNumber),
      eq(hostedPhoneNumbers.status, "ACTIVE"),
    )).limit(1);
  if (!row || row.readiness !== "READY" || row.registrationStatus !== "READY" || !row.policy) {
    throw new AppError("SMS_CAMPAIGN_NOT_APPROVED", "Your phone number does not have a verified SMS campaign.", 409);
  }
  return row.policy as ApprovedSmsPolicy;
}

async function smsReplyContext(workspaceId: string, conversationId: string) {
  const [last] = await db.select({ body: messages.body, createdAt: messages.createdAt })
    .from(messages).where(and(
      eq(messages.workspaceId, workspaceId),
      eq(messages.conversationId, conversationId),
      eq(messages.channel, "SMS"),
      eq(messages.direction, "INBOUND"),
    )).orderBy(desc(messages.createdAt)).limit(1);
  return {
    lastCustomerMessage: last?.body ?? null,
    currentConversationReply: Boolean(last && Date.now() - last.createdAt.getTime() <= 24 * 60 * 60 * 1000),
  };
}

export async function sendSmsConversationTextWithRuntime(
  workspaceId: string,
  conversationId: string,
  runtime: SmsRuntime,
  input: {
    senderType: "AI" | "USER" | "SYSTEM";
    text: string;
    to?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  },
) {
  if (runtime.mode === "HOSTED" && !outboundSmsReady(runtime.messagingReadiness)) {
    const code = runtime.messagingReadiness === "REJECTED" ? "SMS_REGISTRATION_REJECTED" : "SMS_REGISTRATION_REQUIRED";
    const message = runtime.messagingReadiness === "REJECTED"
      ? "Outbound SMS registration was rejected and must be corrected before sending."
      : "Outbound SMS is not ready yet. Carrier registration must be approved before sending.";
    throw new AppError(code, message, 409);
  }

  const conversation = await conversationState(workspaceId, conversationId);
  if (input.senderType === "USER" && conversation.handlingMode !== "HUMAN") {
    throw new AppError("HUMAN_TAKEOVER_REQUIRED", "Take over this conversation before sending a staff SMS reply.", 409);
  }

  const text = smsText(input.text);
  const to = input.to ?? await destination(workspaceId, conversationId);
  // Treat a free-form human draft and an AI-generated message identically: the caller
  // does not get to choose its compliance category. Approved scope is carrier-derived.
  let actualPurpose: SmsPurpose = "TRANSACTIONAL";
  if (runtime.mode === "HOSTED") {
    const policy = await managedSmsPolicy(workspaceId, runtime.senderNumber);
    const reply = await smsReplyContext(workspaceId, conversationId);
    actualPurpose = validateApprovedSmsMessage({
      policy,
      classifiedPurpose: await classifySmsPurpose({
        workspaceId, referenceId: conversationId, message: text,
        campaignDescription: policy.description, lastCustomerMessage: reply.lastCustomerMessage,
      }),
      text,
    });
    const consent = await getSmsConsentStatus(workspaceId, to, actualPurpose);
    if (!consentAllowsSend({ consent, purpose: actualPurpose, currentConversationReply: reply.currentConversationReply })) {
      throw new AppError("SMS_CONSENT_REQUIRED", "This contact has not opted in to this type of message or has opted out.", 409);
    }
  }
  const segmentUsage = analyzeSmsSegments(text);
  const outbound = await appendMessage(workspaceId, conversationId, {
    channel: "SMS",
    direction: "OUTBOUND",
    senderType: input.senderType,
    contentType: "TEXT",
    body: text,
    provider: runtime.providerName,
    externalMessageId: null,
    status: "SENDING",
    metadata: { mode: runtime.mode, ...(runtime.mode === "HOSTED" ? { smsPurpose: actualPurpose } : {}), ...(input.metadata ?? {}) },
  });

  let hostedCharge: HostedSmsCharge | null = null;
  try {
    hostedCharge = await reserveHostedCredits(workspaceId, runtime, outbound.id, segmentUsage.segments);
  } catch (error) {
    await markSmsSendFailure(workspaceId, outbound.id, "FAILED", error);
    throw error;
  }

  if (input.senderType === "AI") {
    const latest = await conversationState(workspaceId, conversationId);
    if (latest.handlingMode !== "AI") {
      await releaseHostedCredits(workspaceId, hostedCharge);
      await db.update(messages).set({
        status: "SUPPRESSED",
        metadata: { ...outbound.metadata, suppressedReason: "HUMAN_TAKEOVER" },
      }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, outbound.id)));
      throw new AppError("AI_HANDLING_PAUSED", "AI reply suppressed because a human took over the conversation.", 409);
    }
  }

  try {
    if (runtime.mode === "HOSTED") {
      // Recheck just before dispatch: a contact can unsubscribe or a campaign can
      // lose approval while a queued message is waiting for credits or AI generation.
      const currentPolicy = await managedSmsPolicy(workspaceId, runtime.senderNumber);
      validateApprovedSmsMessage({ policy: currentPolicy, classifiedPurpose: actualPurpose, text });
      const consent = await getSmsConsentStatus(workspaceId, to, actualPurpose);
      const reply = await smsReplyContext(workspaceId, conversationId);
      if (!consentAllowsSend({ consent, purpose: actualPurpose, currentConversationReply: reply.currentConversationReply })) {
        throw new AppError("SMS_CONSENT_REQUIRED", "This contact has opted out or lacks consent for this message.", 409);
      }
    }
    const sent = await runtime.provider.send({
      to,
      from: runtime.senderNumber,
      text,
      statusCallbackUrl: statusCallbackUrl(runtime.providerName, workspaceId),
      idempotencyKey: input.idempotencyKey ?? outbound.id,
    });
    await settleHostedCredits(workspaceId, hostedCharge, outbound.id);
    const updated = await attachSmsProviderMessage(workspaceId, outbound.id, runtime.providerName, sent.externalId, sent.status);
    await recordUsage(workspaceId, runtime, outbound.id, hostedCharge, {
      messages: 1,
      status: sent.status,
      encoding: segmentUsage.encoding,
      segments: segmentUsage.segments,
      units: segmentUsage.units,
    });
    return updated;
  } catch (error) {
    if (error instanceof AppError) {
      // A policy change or late opt-out is a local suppression, not an uncertain carrier
      // send. Release credits and preserve an explicit, non-delivered message status.
      await markSmsSendFailure(workspaceId, outbound.id, "SUPPRESSED", error);
      await releaseHostedCredits(workspaceId, hostedCharge);
      throw error;
    }
    const uncertain = uncertainProviderFailure(error);
    await markSmsSendFailure(workspaceId, outbound.id, uncertain ? "SEND_UNKNOWN" : "FAILED", error);
    if (hostedCharge && definitiveProviderRejection(error)) {
      await releaseHostedCredits(workspaceId, hostedCharge);
    } else if (hostedCharge && uncertain) {
      await settleHostedCredits(workspaceId, hostedCharge, outbound.id);
      await recordUsage(workspaceId, runtime, outbound.id, hostedCharge, {
        messages: 0,
        outcome: "unknown",
        encoding: segmentUsage.encoding,
        segments: segmentUsage.segments,
        units: segmentUsage.units,
      });
    }
    throw error;
  }
}

export async function sendSmsConversationText(
  workspaceId: string,
  conversationId: string,
  input: { senderType: "AI" | "USER" | "SYSTEM"; text: string; idempotencyKey?: string; metadata?: Record<string, unknown> },
) {
  const runtime = await resolveSmsRuntimeForWorkspace(workspaceId);
  return sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime, input);
}

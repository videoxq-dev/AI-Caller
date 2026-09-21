import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { usageEvents } from "@/db/schema";
import { analyzeSmsSegments } from "@/server/billing/sms-segments";
import { loadHostedRateSnapshot, quoteHostedUsage } from "@/server/billing/pricing";
import { chargeUnavoidableCredits } from "@/server/credits/service";
import { appendMessage, getOrCreateContactByIdentity, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { enqueueUniqueJob } from "@/server/jobs";
import { SMS_INBOUND_RESPONSE, smsInboundResponseJobSchema, type SmsInboundResponseJob } from "@/server/jobs/queues";
import { responseOrchestrator } from "@/server/orchestrator";
import { handleBookingTurn } from "@/server/booking/conversation";
import { recordBookingPreviewDelivery } from "@/server/booking/offers";
import { shouldUseBookingV2 } from "@/server/booking/rollout";
import type { NormalizedSmsEvent, SmsWebhookInput } from "@/server/providers/contracts";
import { outboundSmsReady } from "@/server/phone-numbers/lifecycle";
import { resolveSmsWebhookRuntime, type SmsProviderName, type SmsRuntime } from "@/server/providers/sms/runtime";
import {
  claimProviderWebhookEvent,
  claimQueuedProviderWebhookEvent,
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
  markProviderWebhookQueued,
  releaseProviderWebhookEventForRetry,
  updateSmsDeliveryStatus,
} from "./repository";
import { sendSmsConversationTextWithRuntime } from "./outbound";
import { recordSmsConsent, smsKeyword } from "./consent";

const MAX_SMS_WEBHOOK_BYTES = 64 * 1024;

type SmsOrchestratorResult = Awaited<ReturnType<typeof responseOrchestrator.respond>>;

type SmsServiceDependencies = {
  resolveRuntime: (workspaceId: string, provider: SmsProviderName) => Promise<SmsRuntime>;
  respond: (workspaceId: string, conversationId: string) => Promise<SmsOrchestratorResult>;
  enqueueResponseJob: (job: SmsInboundResponseJob) => Promise<string | null>;
};

async function readWebhookBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SMS_WEBHOOK_BYTES) {
    throw new AppError("SMS_WEBHOOK_TOO_LARGE", "SMS webhook payload is too large.", 413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_SMS_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new AppError("SMS_WEBHOOK_TOO_LARGE", "SMS webhook payload is too large.", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeEventPayload(event: NormalizedSmsEvent) {
  return event.type === "MESSAGE_RECEIVED"
    ? { type: event.type, externalMessageId: event.externalMessageId, from: normalizePhone(event.from), to: normalizePhone(event.to) }
    : { type: event.type, externalMessageId: event.externalMessageId, status: event.status };
}

function jobFromEvent(
  workspaceId: string,
  provider: SmsProviderName,
  webhookEventId: string,
  event: Extract<NormalizedSmsEvent, { type: "MESSAGE_RECEIVED" }>,
): SmsInboundResponseJob {
  return smsInboundResponseJobSchema.parse({
    workspaceId,
    provider,
    webhookEventId,
    externalMessageId: event.externalMessageId,
    customerNumber: normalizePhone(event.from),
    destinationNumber: normalizePhone(event.to),
    text: event.text,
  });
}

function queuedJobFromPayload(workspaceId: string, provider: SmsProviderName, eventId: string, payload: Record<string, unknown>) {
  return smsInboundResponseJobSchema.safeParse({
    workspaceId,
    provider,
    webhookEventId: eventId,
    externalMessageId: payload.externalMessageId,
    customerNumber: payload.customerNumber,
    destinationNumber: payload.destinationNumber,
    text: payload.text,
  });
}

function webhookUrl(provider: SmsProviderName, workspaceId: string) {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/api/webhooks/sms/${provider}/${workspaceId}`;
}

async function chargeHostedInboundSms(
  workspaceId: string,
  runtime: SmsRuntime,
  externalMessageId: string,
  text: string,
) {
  if (runtime.mode !== "HOSTED") return null;

  const segmentUsage = analyzeSmsSegments(text);
  const rates = await loadHostedRateSnapshot({
    capability: "SMS",
    provider: runtime.providerName,
    model: "",
    units: ["SMS_SEGMENT"],
  });
  const quote = quoteHostedUsage(rates, [{ unit: "SMS_SEGMENT", units: segmentUsage.segments }]);
  if (quote.credits <= 0) throw new Error("Hosted inbound SMS charge must be positive.");

  const referenceId = `${runtime.providerName}:${externalMessageId}`;
  await chargeUnavoidableCredits(workspaceId, quote.credits, {
    reason: "Hosted inbound SMS message",
    referenceType: "SMS_INBOUND_MESSAGE",
    referenceId,
  });

  await db.insert(usageEvents).values({
    workspaceId,
    capability: "SMS",
    provider: runtime.providerName,
    mode: "HOSTED",
    providerUsage: {
      messages: 1,
      direction: "INBOUND",
      encoding: segmentUsage.encoding,
      segments: segmentUsage.segments,
      units: segmentUsage.units,
    },
    creditsCharged: quote.credits,
    providerCostMicros: quote.providerCostMicros,
    billedUnits: quote.billedUnits,
    pricingDetails: quote.pricingDetails,
    referenceType: "SMS_INBOUND",
    referenceId,
  }).onConflictDoNothing();

  return quote;
}

export function createSmsWebhookService(dependencies: SmsServiceDependencies) {
  async function enqueueInbound(job: SmsInboundResponseJob) {
    return dependencies.enqueueResponseJob(job);
  }

  async function enqueueExistingQueuedEvent(
    workspaceId: string,
    providerName: SmsProviderName,
    eventId: string,
    payload: Record<string, unknown>,
  ) {
    const queuedJob = queuedJobFromPayload(workspaceId, providerName, eventId, payload);
    if (!queuedJob.success) {
      throw new AppError("INVALID_QUEUED_SMS_EVENT", "Queued SMS webhook data is incomplete.", 409);
    }
    await enqueueInbound(queuedJob.data);
  }

  return {
    async ingest(request: Request, workspaceId: string, providerName: SmsProviderName) {
      const rawBody = await readWebhookBody(request);
      const runtime = await dependencies.resolveRuntime(workspaceId, providerName);
      const webhookInput: SmsWebhookInput = {
        request,
        rawBody,
        webhookUrl: webhookUrl(providerName, workspaceId),
        contentType: request.headers.get("content-type"),
      };

      if (!(await runtime.provider.verifyWebhook(webhookInput))) {
        throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Invalid SMS webhook signature.", 401);
      }

      const events = await runtime.provider.normalizeWebhook(webhookInput);
      let queued = 0;
      let processed = 0;
      let duplicates = 0;
      let deferred = 0;
      let suppressed = 0;

      for (const event of events) {
        if (runtime.mode === "HOSTED" && runtime.serviceStatus === "SUSPENDED" && event.type === "MESSAGE_RECEIVED" && !["STOP", "START"].includes(smsKeyword(event.text) ?? "")) {
          suppressed += 1;
          continue;
        }
        if (event.type === "MESSAGE_RECEIVED" && normalizePhone(event.to) !== runtime.senderNumber) {
          throw new AppError("SMS_DESTINATION_MISMATCH", "The inbound SMS destination does not match this workspace's configured SMS number.", 409);
        }

        const eventPayload = safeEventPayload(event);
        const claim = await claimProviderWebhookEvent(workspaceId, {
          provider: providerName,
          externalEventId: event.externalEventId,
          payload: eventPayload,
        });

        if (event.type === "DELIVERY_UPDATED") {
          const updated = await updateSmsDeliveryStatus(workspaceId, providerName, event.externalMessageId, event.status, event.error);
          if (!updated) {
            await failProviderWebhookEvent(workspaceId, claim.eventId, new Error("Delivery callback arrived before the outbound message was persisted."));
            deferred += 1;
            continue;
          }
          await completeProviderWebhookEvent(workspaceId, claim.eventId);
          processed += 1;
          continue;
        }

        if (claim.status === "PROCESSED" || claim.status === "FAILED" || claim.status === "PROCESSING") {
          duplicates += 1;
          continue;
        }

        if (claim.status === "QUEUED") {
          await enqueueExistingQueuedEvent(workspaceId, providerName, claim.eventId, claim.payload);
          duplicates += 1;
          continue;
        }

        const job = jobFromEvent(workspaceId, providerName, claim.eventId, event);
        const queuedEvent = await markProviderWebhookQueued(workspaceId, claim.eventId, {
          ...eventPayload,
          ...job,
        });

        if (!queuedEvent) {
          const refreshed = await claimProviderWebhookEvent(workspaceId, {
            provider: providerName,
            externalEventId: event.externalEventId,
            payload: eventPayload,
          });
          if (refreshed.status === "QUEUED") {
            await enqueueExistingQueuedEvent(workspaceId, providerName, refreshed.eventId, refreshed.payload);
          }
          duplicates += 1;
          continue;
        }

        await enqueueInbound(job);
        queued += 1;
      }

      if (deferred > 0) {
        // A delivery webhook may beat the outbound provider-ID database commit.
        // Telnyx retries 5xx responses; acknowledging this as 202 would lose the
        // only delivery evidence. Duplicate inbound events are safely deduplicated.
        throw new AppError(
          "SMS_DELIVERY_DEFERRED",
          "Delivery confirmation arrived before its outbound message was persisted. Retry this webhook.",
          503,
        );
      }
      return { ok: true as const, queued, processed, duplicates, deferred, suppressed };
    },

    async processInboundJob(input: SmsInboundResponseJob) {
      const job = smsInboundResponseJobSchema.parse(input);
      const claimed = await claimQueuedProviderWebhookEvent(job.workspaceId, job.webhookEventId);
      if (!claimed) return { skipped: true as const };

      let terminalFailure = false;
      try {
        const runtime = await dependencies.resolveRuntime(job.workspaceId, job.provider);
        if (job.destinationNumber !== runtime.senderNumber) {
          throw new AppError("SMS_DESTINATION_MISMATCH", "The inbound SMS destination does not match this workspace's configured SMS number.", 409);
        }

        const contact = await getOrCreateContactByIdentity(job.workspaceId, { channel: "SMS", externalId: job.customerNumber });
        const conversation = await getOrCreateOpenConversation(job.workspaceId, contact.id);
        const inbound = await appendMessage(job.workspaceId, conversation.id, {
          channel: "SMS",
          direction: "INBOUND",
          senderType: "CUSTOMER",
          contentType: "TEXT",
          body: job.text,
          provider: job.provider,
          externalMessageId: job.externalMessageId,
          status: "RECEIVED",
          metadata: { providerEventId: job.webhookEventId, senderNumber: job.customerNumber },
        });
        // Opt-out evidence must be recorded even when the hosted wallet cannot pay
        // inbound usage charges. Billing failures cannot authorize further messages.
        const keyword = smsKeyword(job.text);
        if (keyword === "STOP" || keyword === "START") {
          const status = keyword === "STOP" ? "OPTED_OUT" : "OPTED_IN";
          const categories = keyword === "STOP" ? ["TRANSACTIONAL", "MARKETING"] as const : ["TRANSACTIONAL"] as const;
          for (const category of categories) {
            await recordSmsConsent(job.workspaceId, contact.id, job.customerNumber, {
              category, status, source: "INBOUND_SMS", sourceReference: job.externalMessageId,
              consentStatement: job.text,
            });
          }
          try {
            await chargeHostedInboundSms(job.workspaceId, runtime, job.externalMessageId, job.text);
          } catch (billingError) {
            logger.error({ err: billingError, workspaceId: job.workspaceId, webhookEventId: job.webhookEventId },
              "Inbound SMS keyword processed but carrier usage could not be charged");
          }
          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return { skipped: false as const, replied: false as const, consentUpdated: true as const };
        }

        await chargeHostedInboundSms(job.workspaceId, runtime, job.externalMessageId, job.text);

        if (runtime.mode === "HOSTED" && !outboundSmsReady(runtime.messagingReadiness)) {
          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return {
            skipped: false as const,
            replied: false as const,
            outboundBlocked: true as const,
            messagingReadiness: runtime.messagingReadiness,
          };
        }

        const bookingContext = {
          workspaceId: job.workspaceId, contactId: contact.id,
          conversationId: conversation.id, channel: "SMS" as const,
          sessionKey: `SMS:${conversation.id}`,
        };
        const bookingTurn = conversation.handlingMode === "AI" &&
          await shouldUseBookingV2(bookingContext)
          ? await handleBookingTurn(bookingContext, { id: inbound.id, body: job.text })
          : null;
        const orchestrated = bookingTurn ? null
          : await dependencies.respond(job.workspaceId, conversation.id);
        const reply = bookingTurn?.reply ?? orchestrated?.reply ?? null;
        if (!reply) {
          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return { skipped: false as const, replied: false as const };
        }
        terminalFailure = true;
        try {
          const outbound = await sendSmsConversationTextWithRuntime(job.workspaceId, conversation.id, runtime, {
            senderType: "AI",
            text: reply,
            to: job.customerNumber,
            idempotencyKey: job.webhookEventId,
            metadata: {
              inReplyToProviderEventId: job.webhookEventId,
              ...(bookingTurn?.preview ? {
                bookingPreviewId: bookingTurn.preview.previewId,
                bookingDraftId: bookingTurn.preview.draftId,
                bookingVersion: bookingTurn.preview.version,
              } : {}),
            },
          });
          if (bookingTurn?.preview) {
            await recordBookingPreviewDelivery(bookingContext, {
              draftId: bookingTurn.preview.draftId,
              previewId: bookingTurn.preview.previewId,
              expectedVersion: bookingTurn.preview.version,
              deliveryChannel: "SMS", deliveryReference: outbound.id,
            });
          }

          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return { skipped: false as const, replied: true as const, messageId: outbound.id };
        } catch (error) {
          if (error instanceof AppError && error.code === "AI_HANDLING_PAUSED") {
            await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
            return { skipped: false as const, replied: false as const };
          }
          throw error;
        }
      } catch (error) {
        if (terminalFailure) {
          await failProviderWebhookEvent(job.workspaceId, job.webhookEventId, error);
        } else {
          await releaseProviderWebhookEventForRetry(job.workspaceId, job.webhookEventId, error);
        }
        throw error;
      }
    },
  };
}

export const smsWebhookService = createSmsWebhookService({
  resolveRuntime: resolveSmsWebhookRuntime,
  respond: (workspaceId, conversationId) => responseOrchestrator.respond(workspaceId, conversationId),
  enqueueResponseJob: (job) => enqueueUniqueJob(SMS_INBOUND_RESPONSE, job.webhookEventId, job),
});

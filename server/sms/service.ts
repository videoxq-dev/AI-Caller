import { db } from "@/db";
import { usageEvents } from "@/db/schema";
import { debitCredits, refundCredits } from "@/server/credits/service";
import { appendMessage, getOrCreateContactByIdentity, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { enqueueUniqueJob } from "@/server/jobs";
import { SMS_INBOUND_RESPONSE, smsInboundResponseJobSchema, type SmsInboundResponseJob } from "@/server/jobs/queues";
import { logger } from "@/server/observability/logger";
import { responseOrchestrator } from "@/server/orchestrator";
import type { NormalizedSmsEvent, SmsWebhookInput } from "@/server/providers/contracts";
import { ProviderRequestError } from "@/server/providers/http";
import { resolveSmsRuntime, type SmsProviderName, type SmsRuntime } from "@/server/providers/sms/runtime";
import {
  attachSmsProviderMessage,
  claimProviderWebhookEvent,
  claimQueuedProviderWebhookEvent,
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
  markProviderWebhookQueued,
  markSmsSendFailure,
  updateProviderWebhookPayload,
  updateSmsDeliveryStatus,
} from "./repository";

type SmsOrchestratorResult = Awaited<ReturnType<typeof responseOrchestrator.respond>>;

type SmsServiceDependencies = {
  resolveRuntime: (workspaceId: string, provider: SmsProviderName) => Promise<SmsRuntime>;
  respond: (workspaceId: string, conversationId: string) => Promise<SmsOrchestratorResult>;
  enqueueResponseJob: (job: SmsInboundResponseJob) => Promise<string | null>;
};

function safeEventPayload(event: NormalizedSmsEvent) {
  return event.type === "MESSAGE_RECEIVED"
    ? { type: event.type, externalMessageId: event.externalMessageId, from: normalizePhone(event.from), to: normalizePhone(event.to) }
    : { type: event.type, externalMessageId: event.externalMessageId, status: event.status };
}

function queuedJobFromPayload(workspaceId: string, provider: SmsProviderName, eventId: string, payload: Record<string, unknown>) {
  return smsInboundResponseJobSchema.safeParse({
    workspaceId,
    provider,
    webhookEventId: eventId,
    conversationId: payload.conversationId,
    customerNumber: payload.customerNumber,
  });
}

async function recordSmsUsage(
  workspaceId: string,
  runtime: SmsRuntime,
  referenceId: string,
  creditsCharged: number,
  providerUsage: Record<string, unknown>,
) {
  try {
    await db.insert(usageEvents).values({
      workspaceId,
      capability: "SMS",
      provider: runtime.providerName,
      mode: runtime.mode,
      providerUsage,
      creditsCharged,
      referenceType: "MESSAGE",
      referenceId,
    });
  } catch (error) {
    logger.error({ err: error, workspaceId, provider: runtime.providerName, referenceId }, "Failed to persist SMS usage event");
  }
}

function uncertainProviderFailure(error: unknown) {
  return !(error instanceof ProviderRequestError) || error.status >= 500;
}

function definitiveProviderRejection(error: unknown) {
  return error instanceof ProviderRequestError && error.status >= 400 && error.status < 500;
}

async function reserveHostedSmsCredits(workspaceId: string, runtime: SmsRuntime, messageId: string) {
  if (runtime.mode !== "HOSTED") return 0;
  const amount = getEnv().HOSTED_SMS_CREDITS_PER_MESSAGE;
  await debitCredits(workspaceId, amount, {
    reason: "Hosted SMS message",
    referenceType: "SMS_MESSAGE",
    referenceId: messageId,
  });
  return amount;
}

async function refundHostedSmsCredits(workspaceId: string, amount: number, messageId: string) {
  if (amount <= 0) return;
  await refundCredits(workspaceId, amount, {
    reason: "Hosted SMS provider rejected message",
    referenceType: "SMS_MESSAGE",
    referenceId: messageId,
  });
}

function webhookUrl(provider: SmsProviderName, workspaceId: string) {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/api/webhooks/sms/${provider}/${workspaceId}`;
}

export function createSmsWebhookService(dependencies: SmsServiceDependencies) {
  async function enqueueInbound(job: SmsInboundResponseJob) {
    return dependencies.enqueueResponseJob(job);
  }

  return {
    async ingest(request: Request, workspaceId: string, providerName: SmsProviderName) {
      const runtime = await dependencies.resolveRuntime(workspaceId, providerName);
      const rawBody = await request.text();
      const webhookInput: SmsWebhookInput = {
        request,
        rawBody,
        webhookUrl: request.url,
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

      for (const event of events) {
        const claim = await claimProviderWebhookEvent(workspaceId, {
          provider: providerName,
          externalEventId: event.externalEventId,
          payload: safeEventPayload(event),
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
          const queuedJob = queuedJobFromPayload(workspaceId, providerName, claim.eventId, claim.payload);
          if (queuedJob.success) await enqueueInbound(queuedJob.data);
          duplicates += 1;
          continue;
        }

        try {
          if (normalizePhone(event.to) !== runtime.senderNumber) {
            throw new AppError("SMS_DESTINATION_MISMATCH", "The inbound SMS destination does not match this workspace's configured SMS number.", 409);
          }

          const contact = await getOrCreateContactByIdentity(workspaceId, { channel: "SMS", externalId: event.from });
          const conversation = await getOrCreateOpenConversation(workspaceId, contact.id);
          await appendMessage(workspaceId, conversation.id, {
            channel: "SMS",
            direction: "INBOUND",
            senderType: "CUSTOMER",
            contentType: "TEXT",
            body: event.text,
            provider: providerName,
            externalMessageId: event.externalMessageId,
            status: "RECEIVED",
            metadata: { providerEventId: event.externalEventId },
          });

          const job: SmsInboundResponseJob = {
            workspaceId,
            provider: providerName,
            webhookEventId: claim.eventId,
            conversationId: conversation.id,
            customerNumber: normalizePhone(event.from),
          };
          await updateProviderWebhookPayload(workspaceId, claim.eventId, { ...safeEventPayload(event), ...job });
          await markProviderWebhookQueued(workspaceId, claim.eventId);
          await enqueueInbound(job);
          queued += 1;
        } catch (error) {
          await failProviderWebhookEvent(workspaceId, claim.eventId, error);
          throw error;
        }
      }

      return { ok: true as const, queued, processed, duplicates, deferred };
    },

    async processInboundJob(input: SmsInboundResponseJob) {
      const job = smsInboundResponseJobSchema.parse(input);
      const claimed = await claimQueuedProviderWebhookEvent(job.workspaceId, job.webhookEventId);
      if (!claimed) return { skipped: true as const };

      try {
        const runtime = await dependencies.resolveRuntime(job.workspaceId, job.provider);
        const orchestrated = await dependencies.respond(job.workspaceId, job.conversationId);
        if (!orchestrated.reply) {
          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return { skipped: false as const, replied: false as const };
        }

        const outbound = await appendMessage(job.workspaceId, job.conversationId, {
          channel: "SMS",
          direction: "OUTBOUND",
          senderType: "AI",
          contentType: "TEXT",
          body: orchestrated.reply,
          provider: job.provider,
          externalMessageId: null,
          status: "SENDING",
          metadata: { inReplyToProviderEventId: job.webhookEventId, mode: runtime.mode },
        });

        let reservedCredits = 0;
        try {
          reservedCredits = await reserveHostedSmsCredits(job.workspaceId, runtime, outbound.id);
          const sent = await runtime.provider.send({
            to: job.customerNumber,
            from: runtime.senderNumber,
            text: orchestrated.reply,
            statusCallbackUrl: webhookUrl(job.provider, job.workspaceId),
            idempotencyKey: job.webhookEventId,
          });
          await attachSmsProviderMessage(job.workspaceId, outbound.id, job.provider, sent.externalId, sent.status);
          await recordSmsUsage(job.workspaceId, runtime, outbound.id, reservedCredits, { messages: 1, status: sent.status });
        } catch (error) {
          const uncertain = uncertainProviderFailure(error);
          await markSmsSendFailure(job.workspaceId, outbound.id, uncertain ? "SEND_UNKNOWN" : "FAILED", error);
          if (reservedCredits > 0 && definitiveProviderRejection(error)) {
            await refundHostedSmsCredits(job.workspaceId, reservedCredits, outbound.id);
          } else if (reservedCredits > 0 && uncertain) {
            await recordSmsUsage(job.workspaceId, runtime, outbound.id, reservedCredits, { messages: 0, outcome: "unknown" });
          }
          throw error;
        }

        await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
        return { skipped: false as const, replied: true as const, messageId: outbound.id };
      } catch (error) {
        await failProviderWebhookEvent(job.workspaceId, job.webhookEventId, error);
        throw error;
      }
    },
  };
}

export const smsWebhookService = createSmsWebhookService({
  resolveRuntime: resolveSmsRuntime,
  respond: (workspaceId, conversationId) => responseOrchestrator.respond(workspaceId, conversationId),
  enqueueResponseJob: (job) => enqueueUniqueJob(SMS_INBOUND_RESPONSE, job.webhookEventId, job),
});

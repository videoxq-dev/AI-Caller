import { appendMessage, getOrCreateContactByIdentity, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { enqueueUniqueJob } from "@/server/jobs";
import { SMS_INBOUND_RESPONSE, smsInboundResponseJobSchema, type SmsInboundResponseJob } from "@/server/jobs/queues";
import { responseOrchestrator } from "@/server/orchestrator";
import type { NormalizedSmsEvent, SmsWebhookInput } from "@/server/providers/contracts";
import { resolveSmsRuntime, type SmsProviderName, type SmsRuntime } from "@/server/providers/sms/runtime";
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

function webhookUrl(provider: SmsProviderName, workspaceId: string) {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/api/webhooks/sms/${provider}/${workspaceId}`;
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

      for (const event of events) {
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

      return { ok: true as const, queued, processed, duplicates, deferred };
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
        await appendMessage(job.workspaceId, conversation.id, {
          channel: "SMS",
          direction: "INBOUND",
          senderType: "CUSTOMER",
          contentType: "TEXT",
          body: job.text,
          provider: job.provider,
          externalMessageId: job.externalMessageId,
          status: "RECEIVED",
          metadata: { providerEventId: job.webhookEventId },
        });

        const orchestrated = await dependencies.respond(job.workspaceId, conversation.id);
        if (!orchestrated.reply) {
          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return { skipped: false as const, replied: false as const };
        }
        terminalFailure = true;
        try {
          const outbound = await sendSmsConversationTextWithRuntime(job.workspaceId, conversation.id, runtime, {
            senderType: "AI",
            text: orchestrated.reply,
            to: job.customerNumber,
            idempotencyKey: job.webhookEventId,
            metadata: { inReplyToProviderEventId: job.webhookEventId },
          });

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
  resolveRuntime: resolveSmsRuntime,
  respond: (workspaceId, conversationId) => responseOrchestrator.respond(workspaceId, conversationId),
  enqueueResponseJob: (job) => enqueueUniqueJob(SMS_INBOUND_RESPONSE, job.webhookEventId, job),
});

import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { AppError } from "@/server/http/errors";
import { enqueueUniqueJob } from "@/server/jobs";
import { WHATSAPP_INBOUND_RESPONSE, whatsappInboundResponseJobSchema, type WhatsAppInboundResponseJob } from "@/server/jobs/queues";
import { responseOrchestrator } from "@/server/orchestrator";
import type { NormalizedWhatsAppEvent, WhatsAppWebhookInput } from "@/server/providers/contracts";
import { normalizeMetaWhatsAppWebhook, verifyMetaWhatsAppWebhook } from "@/server/providers/whatsapp/meta-cloud";
import {
  resolveWhatsAppRuntimeByPhoneNumberId,
  resolveWhatsAppRuntimeForWorkspace,
  type WhatsAppRuntime,
} from "@/server/providers/whatsapp/runtime";
import {
  claimProviderWebhookEvent,
  claimQueuedProviderWebhookEvent,
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
  markProviderWebhookQueued,
  releaseProviderWebhookEventForRetry,
} from "@/server/providers/webhooks/repository";
import { resolveWhatsAppContact } from "./identity";
import { sendWhatsAppConversationText } from "./outbound";
import { updateWhatsAppDeliveryStatus } from "./repository";

const MAX_WHATSAPP_WEBHOOK_BYTES = 64 * 1024;

type WhatsAppOrchestratorResult = Awaited<ReturnType<typeof responseOrchestrator.respond>>;

type WhatsAppServiceDependencies = {
  resolveByPhoneNumberId: (phoneNumberId: string) => Promise<WhatsAppRuntime>;
  resolveForWorkspace: (workspaceId: string) => Promise<WhatsAppRuntime>;
  respond: (workspaceId: string, conversationId: string) => Promise<WhatsAppOrchestratorResult>;
  sendText: (
    workspaceId: string,
    conversationId: string,
    input: { senderType: "AI" | "USER"; text: string },
  ) => Promise<unknown>;
  enqueueResponseJob: (job: WhatsAppInboundResponseJob) => Promise<string | null>;
};

async function readWebhookBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WHATSAPP_WEBHOOK_BYTES) {
    throw new AppError("WHATSAPP_WEBHOOK_TOO_LARGE", "WhatsApp webhook payload is too large.", 413);
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
      if (total > MAX_WHATSAPP_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new AppError("WHATSAPP_WEBHOOK_TOO_LARGE", "WhatsApp webhook payload is too large.", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeEventPayload(event: NormalizedWhatsAppEvent) {
  return event.type === "MESSAGE_RECEIVED"
    ? {
        type: event.type,
        externalMessageId: event.externalMessageId,
        phoneNumberId: event.phoneNumberId,
        from: event.from,
      }
    : {
        type: event.type,
        externalMessageId: event.externalMessageId,
        phoneNumberId: event.phoneNumberId,
        status: event.status,
        error: event.error,
        occurredAt: event.occurredAt?.toISOString() ?? null,
      };
}

function jobFromEvent(
  workspaceId: string,
  webhookEventId: string,
  event: Extract<NormalizedWhatsAppEvent, { type: "MESSAGE_RECEIVED" }>,
) {
  return whatsappInboundResponseJobSchema.parse({
    workspaceId,
    webhookEventId,
    externalMessageId: event.externalMessageId,
    phoneNumberId: event.phoneNumberId,
    customerWaId: event.from,
    profileName: event.profileName,
    text: event.text,
    occurredAt: event.occurredAt?.toISOString() ?? null,
  });
}

function queuedJobFromPayload(workspaceId: string, eventId: string, payload: Record<string, unknown>) {
  return whatsappInboundResponseJobSchema.safeParse({
    workspaceId,
    webhookEventId: eventId,
    externalMessageId: payload.externalMessageId,
    phoneNumberId: payload.phoneNumberId,
    customerWaId: payload.customerWaId,
    profileName: payload.profileName ?? null,
    text: payload.text,
    occurredAt: payload.occurredAt ?? null,
  });
}

export function createWhatsAppWebhookService(dependencies: WhatsAppServiceDependencies) {
  async function enqueueExistingQueuedEvent(workspaceId: string, eventId: string, payload: Record<string, unknown>) {
    const queued = queuedJobFromPayload(workspaceId, eventId, payload);
    if (!queued.success) throw new AppError("INVALID_QUEUED_WHATSAPP_EVENT", "Queued WhatsApp webhook data is incomplete.", 409);
    await dependencies.enqueueResponseJob(queued.data);
  }

  return {
    async ingest(request: Request) {
      const rawBody = await readWebhookBody(request);
      const webhookInput: WhatsAppWebhookInput = { request, rawBody };
      if (!verifyMetaWhatsAppWebhook(webhookInput)) {
        throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Invalid WhatsApp webhook signature.", 401);
      }

      const events = normalizeMetaWhatsAppWebhook(webhookInput);
      let queued = 0;
      let processed = 0;
      let duplicates = 0;
      let deferred = 0;
      const runtimes = new Map<string, Promise<WhatsAppRuntime>>();

      for (const event of events) {
        let runtimePromise = runtimes.get(event.phoneNumberId);
        if (!runtimePromise) {
          runtimePromise = dependencies.resolveByPhoneNumberId(event.phoneNumberId);
          runtimes.set(event.phoneNumberId, runtimePromise);
        }
        const runtime = await runtimePromise;
        const eventPayload = safeEventPayload(event);
        const claim = await claimProviderWebhookEvent(runtime.workspaceId, {
          provider: "whatsapp",
          externalEventId: event.externalEventId,
          payload: eventPayload,
        });

        if (event.type === "DELIVERY_UPDATED") {
          const updated = await updateWhatsAppDeliveryStatus(
            runtime.workspaceId,
            event.externalMessageId,
            event.status,
            event.error,
            event.occurredAt,
          );
          if (!updated) {
            deferred += 1;
            continue;
          }
          await completeProviderWebhookEvent(runtime.workspaceId, claim.eventId);
          processed += 1;
          continue;
        }

        if (claim.status === "PROCESSED" || claim.status === "FAILED" || claim.status === "PROCESSING") {
          duplicates += 1;
          continue;
        }
        if (claim.status === "QUEUED") {
          await enqueueExistingQueuedEvent(runtime.workspaceId, claim.eventId, claim.payload);
          duplicates += 1;
          continue;
        }

        const job = jobFromEvent(runtime.workspaceId, claim.eventId, event);
        const queuedEvent = await markProviderWebhookQueued(runtime.workspaceId, claim.eventId, {
          ...eventPayload,
          ...job,
        });
        if (!queuedEvent) {
          duplicates += 1;
          continue;
        }
        await dependencies.enqueueResponseJob(job);
        queued += 1;
      }

      return { ok: true as const, queued, processed, duplicates, deferred };
    },

    async processInboundJob(input: WhatsAppInboundResponseJob) {
      const job = whatsappInboundResponseJobSchema.parse(input);
      const claimed = await claimQueuedProviderWebhookEvent(job.workspaceId, job.webhookEventId);
      if (!claimed) return { skipped: true as const };

      let failClosed = false;
      try {
        const runtime = await dependencies.resolveForWorkspace(job.workspaceId);
        if (runtime.phoneNumberId !== job.phoneNumberId) {
          throw new AppError("WHATSAPP_DESTINATION_MISMATCH", "The WhatsApp phone number ID does not match this workspace.", 409);
        }

        const contact = await resolveWhatsAppContact(job.workspaceId, job.customerWaId, job.profileName);
        const conversation = await getOrCreateOpenConversation(job.workspaceId, contact.id);
        await appendMessage(job.workspaceId, conversation.id, {
          channel: "WHATSAPP",
          direction: "INBOUND",
          senderType: "CUSTOMER",
          contentType: "TEXT",
          body: job.text,
          provider: "whatsapp",
          externalMessageId: job.externalMessageId,
          status: "RECEIVED",
          metadata: {
            providerEventId: job.webhookEventId,
            whatsappWaId: job.customerWaId,
            ...(job.occurredAt ? { occurredAt: job.occurredAt } : {}),
          },
        });

        // The orchestrator may execute irreversible calendar/provider tools. Once it begins,
        // retries must fail closed rather than replaying the same customer turn.
        failClosed = true;
        const orchestrated = await dependencies.respond(job.workspaceId, conversation.id);
        if (!orchestrated.reply) {
          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return { skipped: false as const, replied: false as const };
        }

        try {
          await dependencies.sendText(job.workspaceId, conversation.id, {
            senderType: "AI",
            text: orchestrated.reply,
          });
        } catch (error) {
          if (error instanceof AppError && error.code === "AI_HANDLING_PAUSED") {
            await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
            return { skipped: false as const, replied: false as const };
          }
          throw error;
        }

        await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
        return { skipped: false as const, replied: true as const };
      } catch (error) {
        if (failClosed) await failProviderWebhookEvent(job.workspaceId, job.webhookEventId, error);
        else await releaseProviderWebhookEventForRetry(job.workspaceId, job.webhookEventId, error);
        throw error;
      }
    },
  };
}

export const whatsAppWebhookService = createWhatsAppWebhookService({
  resolveByPhoneNumberId: resolveWhatsAppRuntimeByPhoneNumberId,
  resolveForWorkspace: resolveWhatsAppRuntimeForWorkspace,
  respond: (workspaceId, conversationId) => responseOrchestrator.respond(workspaceId, conversationId),
  sendText: sendWhatsAppConversationText,
  enqueueResponseJob: (job) => enqueueUniqueJob(WHATSAPP_INBOUND_RESPONSE, job.webhookEventId, job),
});

import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { AppError } from "@/server/http/errors";
import { enqueueUniqueJob } from "@/server/jobs";
import { WHATSAPP_INBOUND_RESPONSE, whatsappInboundResponseJobSchema, type WhatsAppInboundResponseJob } from "@/server/jobs/queues";
import { responseOrchestrator } from "@/server/orchestrator";
import { handleBookingTurn } from "@/server/booking/conversation";
import {
  handleAppointmentManagementTurn, recordAppointmentManagementPreviewDelivery,
} from "@/server/booking/management";
import { recordBookingPreviewDelivery } from "@/server/booking/offers";
import { shouldUseBookingV2 } from "@/server/booking/rollout";
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
    input: { senderType: "AI" | "USER"; text: string; metadata?: Record<string, unknown> },
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
        const inbound = await appendMessage(job.workspaceId, conversation.id, {
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

        // The durable booking engine and the legacy orchestrator are both
        // consequential. Once either begins, a provider retry must not replay
        // the same inbound turn as a fresh action.
        failClosed = true;
        const bookingContext = {
          workspaceId: job.workspaceId, contactId: contact.id,
          conversationId: conversation.id, channel: "WHATSAPP" as const,
          sessionKey: `WHATSAPP:${conversation.id}`,
        };
        const managementTurn = conversation.handlingMode === "AI"
          ? await handleAppointmentManagementTurn(
              bookingContext, { id: inbound.id, body: job.text },
            )
          : null;
        const bookingTurn = !managementTurn && conversation.handlingMode === "AI" &&
          await shouldUseBookingV2(bookingContext)
          ? await handleBookingTurn(bookingContext, { id: inbound.id, body: job.text })
          : null;
        const orchestrated = managementTurn || bookingTurn ? null
          : await dependencies.respond(job.workspaceId, conversation.id);
        const reply = managementTurn?.reply ?? bookingTurn?.reply ?? orchestrated?.reply ?? null;
        if (!reply) {
          await completeProviderWebhookEvent(job.workspaceId, job.webhookEventId);
          return { skipped: false as const, replied: false as const };
        }

        try {
          const outbound = await dependencies.sendText(job.workspaceId, conversation.id, {
            senderType: "AI",
            text: reply,
            metadata: managementTurn?.preview
              ? { appointmentManagementRequestId: managementTurn.preview.requestId }
              : bookingTurn?.preview ? {
              bookingPreviewId: bookingTurn.preview.previewId,
              bookingDraftId: bookingTurn.preview.draftId,
              bookingVersion: bookingTurn.preview.version,
            } : undefined,
          });
          if (managementTurn?.preview) {
            const messageId = outbound && typeof outbound === "object" &&
              "id" in outbound && typeof (outbound as { id?: unknown }).id === "string"
                ? (outbound as { id: string }).id : null;
            if (!messageId) throw new AppError("APPOINTMENT_MANAGEMENT_DELIVERY_UNVERIFIED",
              "WhatsApp accepted no durable receipt for the appointment-change preview.", 503);
            await recordAppointmentManagementPreviewDelivery(
              bookingContext, managementTurn.preview.requestId, messageId,
            );
          }
          if (bookingTurn?.preview) {
            const messageId = outbound && typeof outbound === "object" &&
              "id" in outbound && typeof (outbound as { id?: unknown }).id === "string"
                ? (outbound as { id: string }).id : null;
            if (!messageId) throw new AppError("BOOKING_DELIVERY_NOT_VERIFIED",
              "WhatsApp accepted no durable message receipt for the booking preview.", 503);
            await recordBookingPreviewDelivery(bookingContext, {
              draftId: bookingTurn.preview.draftId,
              previewId: bookingTurn.preview.previewId,
              expectedVersion: bookingTurn.preview.version,
              deliveryChannel: "WHATSAPP", deliveryReference: messageId,
            });
          }
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

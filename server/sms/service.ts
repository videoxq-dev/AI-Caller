import { db } from "@/db";
import { usageEvents } from "@/db/schema";
import { debitCredits, refundCredits } from "@/server/credits/service";
import { appendMessage, getOrCreateContactByIdentity, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { responseOrchestrator } from "@/server/orchestrator";
import type { NormalizedSmsEvent, SmsWebhookInput } from "@/server/providers/contracts";
import { ProviderRequestError } from "@/server/providers/http";
import { resolveSmsRuntime, type SmsProviderName, type SmsRuntime } from "@/server/providers/sms/runtime";
import {
  attachSmsProviderMessage,
  claimProviderWebhookEvent,
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
  markSmsSendFailure,
  updateSmsDeliveryStatus,
} from "./repository";

type SmsOrchestratorResult = Awaited<ReturnType<typeof responseOrchestrator.respond>>;

type SmsServiceDependencies = {
  resolveRuntime: (workspaceId: string, provider: SmsProviderName) => Promise<SmsRuntime>;
  respond: (workspaceId: string, conversationId: string) => Promise<SmsOrchestratorResult>;
};

function safeEventPayload(event: NormalizedSmsEvent) {
  return event.type === "MESSAGE_RECEIVED"
    ? { type: event.type, externalMessageId: event.externalMessageId, from: normalizePhone(event.from), to: normalizePhone(event.to) }
    : { type: event.type, externalMessageId: event.externalMessageId, status: event.status };
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

export function createSmsWebhookService(dependencies: SmsServiceDependencies) {
  return {
    async process(request: Request, workspaceId: string, providerName: SmsProviderName) {
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
          const updated = await updateSmsDeliveryStatus(
            workspaceId,
            providerName,
            event.externalMessageId,
            event.status,
            event.error,
          );
          if (!updated) {
            await failProviderWebhookEvent(workspaceId, claim.eventId, new Error("Delivery callback arrived before the outbound message was persisted."));
            deferred += 1;
            continue;
          }
          await completeProviderWebhookEvent(workspaceId, claim.eventId);
          processed += 1;
          continue;
        }

        if (claim.state === "duplicate") {
          duplicates += 1;
          continue;
        }

        try {
          if (normalizePhone(event.to) !== runtime.senderNumber) {
            throw new AppError("SMS_DESTINATION_MISMATCH", "The inbound SMS destination does not match this workspace's configured SMS number.", 409);
          }

          const contact = await getOrCreateContactByIdentity(workspaceId, {
            channel: "SMS",
            externalId: event.from,
          });
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

          const orchestrated = await dependencies.respond(workspaceId, conversation.id);
          if (!orchestrated.reply) {
            await completeProviderWebhookEvent(workspaceId, claim.eventId);
            processed += 1;
            continue;
          }

          const outbound = await appendMessage(workspaceId, conversation.id, {
            channel: "SMS",
            direction: "OUTBOUND",
            senderType: "AI",
            contentType: "TEXT",
            body: orchestrated.reply,
            provider: providerName,
            externalMessageId: null,
            status: "SENDING",
            metadata: { inReplyToProviderEventId: event.externalEventId, mode: runtime.mode },
          });

          let reservedCredits = 0;
          try {
            reservedCredits = await reserveHostedSmsCredits(workspaceId, runtime, outbound.id);
            const sent = await runtime.provider.send({
              to: normalizePhone(event.from),
              from: runtime.senderNumber,
              text: orchestrated.reply,
              statusCallbackUrl: request.url,
              idempotencyKey: event.externalEventId,
            });
            await attachSmsProviderMessage(workspaceId, outbound.id, providerName, sent.externalId, sent.status);
            await recordSmsUsage(workspaceId, runtime, outbound.id, reservedCredits, { messages: 1, status: sent.status });
          } catch (error) {
            const uncertain = uncertainProviderFailure(error);
            await markSmsSendFailure(workspaceId, outbound.id, uncertain ? "SEND_UNKNOWN" : "FAILED", error);
            if (reservedCredits > 0 && definitiveProviderRejection(error)) {
              await refundHostedSmsCredits(workspaceId, reservedCredits, outbound.id);
            } else if (reservedCredits > 0 && uncertain) {
              await recordSmsUsage(workspaceId, runtime, outbound.id, reservedCredits, { messages: 0, outcome: "unknown" });
            }
            throw error;
          }

          await completeProviderWebhookEvent(workspaceId, claim.eventId);
          processed += 1;
        } catch (error) {
          await failProviderWebhookEvent(workspaceId, claim.eventId, error);
          throw error;
        }
      }

      return { ok: true as const, processed, duplicates, deferred };
    },
  };
}

export const smsWebhookService = createSmsWebhookService({
  resolveRuntime: resolveSmsRuntime,
  respond: (workspaceId, conversationId) => responseOrchestrator.respond(workspaceId, conversationId),
});

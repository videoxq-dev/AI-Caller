import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, usageEvents } from "@/db/schema";
import { appendMessage } from "@/server/domain/core/repository";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { ProviderRequestError } from "@/server/providers/http";
import { resolveWhatsAppRuntimeForWorkspace, type WhatsAppRuntime } from "@/server/providers/whatsapp/runtime";
import {
  attachWhatsAppProviderMessage,
  getWhatsAppConversationRecipient,
  latestWhatsAppInboundAt,
  markWhatsAppSendFailure,
  reconcileDeferredWhatsAppDeliveryStatuses,
} from "./repository";

const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_WINDOW_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_WHATSAPP_TEXT_CHARACTERS = 4096;

type OutboundDependencies = {
  resolveRuntime: (workspaceId: string) => Promise<WhatsAppRuntime>;
};

function whatsappText(value: string) {
  const text = value.trim();
  if (!text) throw new AppError("EMPTY_WHATSAPP_MESSAGE", "WhatsApp message cannot be empty.", 400);
  const characters = Array.from(text);
  if (characters.length <= MAX_WHATSAPP_TEXT_CHARACTERS) return text;
  return `${characters.slice(0, MAX_WHATSAPP_TEXT_CHARACTERS - 1).join("")}…`;
}

function uncertainProviderFailure(error: unknown) {
  return !(error instanceof ProviderRequestError) || error.status >= 500;
}

async function recordUsage(workspaceId: string, referenceId: string, providerUsage: Record<string, unknown>) {
  try {
    await db.insert(usageEvents).values({
      workspaceId,
      capability: "WHATSAPP",
      provider: "whatsapp",
      mode: "BYOP",
      providerUsage,
      creditsCharged: 0,
      referenceType: "MESSAGE",
      referenceId,
    });
  } catch (error) {
    logger.error({ err: error, workspaceId, referenceId }, "Failed to persist WhatsApp usage event");
  }
}

async function reconcileDeliveryAfterConfirmedSend(workspaceId: string, externalMessageId: string) {
  try {
    await reconcileDeferredWhatsAppDeliveryStatuses(workspaceId, externalMessageId);
  } catch (error) {
    logger.error(
      { err: error, workspaceId, externalMessageId },
      "Failed to reconcile deferred WhatsApp delivery status after confirmed send",
    );
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
  const recipient = await getWhatsAppConversationRecipient(workspaceId, conversationId);
  if (!recipient) throw new AppError("WHATSAPP_IDENTITY_NOT_FOUND", "This conversation does not have a WhatsApp identity.", 409);
  return recipient;
}

export async function isWhatsAppCustomerWindowOpen(workspaceId: string, conversationId: string, now = new Date()) {
  const lastInbound = await latestWhatsAppInboundAt(workspaceId, conversationId);
  if (!lastInbound) return false;
  const ageMs = now.getTime() - lastInbound.getTime();
  return ageMs >= -CUSTOMER_WINDOW_FUTURE_TOLERANCE_MS && ageMs <= CUSTOMER_WINDOW_MS;
}

export function createWhatsAppOutboundService(dependencies: OutboundDependencies) {
  return {
    async sendText(
      workspaceId: string,
      conversationId: string,
      input: { senderType: "AI" | "USER"; text: string },
    ) {
      const conversation = await conversationState(workspaceId, conversationId);
      if (input.senderType === "USER" && conversation.handlingMode !== "HUMAN") {
        throw new AppError("HUMAN_TAKEOVER_REQUIRED", "Take over this conversation before sending a staff WhatsApp reply.", 409);
      }
      if (!(await isWhatsAppCustomerWindowOpen(workspaceId, conversationId))) {
        throw new AppError("WHATSAPP_TEMPLATE_REQUIRED", "The 24-hour WhatsApp customer service window has closed. Send an approved template instead.", 409);
      }

      const runtime = await dependencies.resolveRuntime(workspaceId);
      const to = await destination(workspaceId, conversationId);
      const text = whatsappText(input.text);
      const outbound = await appendMessage(workspaceId, conversationId, {
        channel: "WHATSAPP",
        direction: "OUTBOUND",
        senderType: input.senderType,
        contentType: "TEXT",
        body: text,
        provider: "whatsapp",
        externalMessageId: null,
        status: "SENDING",
        metadata: { mode: runtime.mode },
      });

      if (input.senderType === "AI") {
        const latest = await conversationState(workspaceId, conversationId);
        if (latest.handlingMode !== "AI") {
          await db.update(messages).set({
            status: "SUPPRESSED",
            metadata: { ...outbound.metadata, suppressedReason: "HUMAN_TAKEOVER" },
          }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, outbound.id)));
          throw new AppError("AI_HANDLING_PAUSED", "AI reply suppressed because a human took over the conversation.", 409);
        }
      }

      try {
        const sent = await runtime.provider.sendText({ phoneNumberId: runtime.phoneNumberId, to, text });
        const updated = await attachWhatsAppProviderMessage(workspaceId, outbound.id, sent.externalId, sent.status);
        await reconcileDeliveryAfterConfirmedSend(workspaceId, sent.externalId);
        await recordUsage(workspaceId, outbound.id, { messages: 1, type: "text", status: sent.status });
        return updated;
      } catch (error) {
        const uncertain = uncertainProviderFailure(error);
        await markWhatsAppSendFailure(workspaceId, outbound.id, uncertain ? "SEND_UNKNOWN" : "FAILED", error);
        await recordUsage(workspaceId, outbound.id, { messages: 0, type: "text", outcome: uncertain ? "unknown" : "rejected" });
        throw error;
      }
    },

    async sendTemplate(
      workspaceId: string,
      conversationId: string,
      input: {
        senderType: "AI" | "USER";
        templateName: string;
        languageCode: string;
        components?: unknown[];
      },
    ) {
      const conversation = await conversationState(workspaceId, conversationId);
      if (input.senderType === "USER" && conversation.handlingMode !== "HUMAN") {
        throw new AppError("HUMAN_TAKEOVER_REQUIRED", "Take over this conversation before sending a staff WhatsApp template.", 409);
      }

      const runtime = await dependencies.resolveRuntime(workspaceId);
      const to = await destination(workspaceId, conversationId);
      const outbound = await appendMessage(workspaceId, conversationId, {
        channel: "WHATSAPP",
        direction: "OUTBOUND",
        senderType: input.senderType,
        contentType: "TEXT",
        body: `WhatsApp template: ${input.templateName}`,
        provider: "whatsapp",
        externalMessageId: null,
        status: "SENDING",
        metadata: { mode: runtime.mode, templateName: input.templateName, languageCode: input.languageCode },
      });

      try {
        const sent = await runtime.provider.sendTemplate({
          phoneNumberId: runtime.phoneNumberId,
          to,
          templateName: input.templateName,
          languageCode: input.languageCode,
          components: input.components,
        });
        const updated = await attachWhatsAppProviderMessage(workspaceId, outbound.id, sent.externalId, sent.status);
        await reconcileDeliveryAfterConfirmedSend(workspaceId, sent.externalId);
        await recordUsage(workspaceId, outbound.id, { messages: 1, type: "template", templateName: input.templateName, status: sent.status });
        return updated;
      } catch (error) {
        const uncertain = uncertainProviderFailure(error);
        await markWhatsAppSendFailure(workspaceId, outbound.id, uncertain ? "SEND_UNKNOWN" : "FAILED", error);
        await recordUsage(workspaceId, outbound.id, { messages: 0, type: "template", templateName: input.templateName, outcome: uncertain ? "unknown" : "rejected" });
        throw error;
      }
    },
  };
}

export const whatsAppOutboundService = createWhatsAppOutboundService({ resolveRuntime: resolveWhatsAppRuntimeForWorkspace });

export function sendWhatsAppConversationText(
  workspaceId: string,
  conversationId: string,
  input: { senderType: "AI" | "USER"; text: string },
) {
  return whatsAppOutboundService.sendText(workspaceId, conversationId, input);
}

export function sendWhatsAppConversationTemplate(
  workspaceId: string,
  conversationId: string,
  input: {
    senderType: "AI" | "USER";
    templateName: string;
    languageCode: string;
    components?: unknown[];
  },
) {
  return whatsAppOutboundService.sendTemplate(workspaceId, conversationId, input);
}

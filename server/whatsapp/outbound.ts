import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, usageEvents } from "@/db/schema";
import { appendMessage } from "@/server/domain/core/repository";
import { AppError } from "@/server/http/errors";
import { hasOpenConversationIssue } from "@/server/collaboration/service";
import { logger } from "@/server/observability/logger";
import { ProviderRequestError } from "@/server/providers/http";
import {
  resolveWhatsAppRuntimeForWorkspace, resolveWhatsAppTemplatesForWorkspace,
  type WhatsAppRuntime,
} from "@/server/providers/whatsapp/runtime";
import { getWhatsAppConsentStatus } from "./consent";
import { classifySmsForPolicy } from "@/server/sms/policy";
import { approvedWhatsAppParameterCount } from "@/server/providers/whatsapp/meta-templates";
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

type ApprovedTemplate = { name: string; language: string; category: string; status: string; body: string };
type OutboundDependencies = {
  resolveRuntime: (workspaceId: string) => Promise<WhatsAppRuntime>;
  getApprovedTemplate?: (workspaceId: string, name: string, language: string) => Promise<ApprovedTemplate>;
};

async function approvedTemplate(workspaceId: string, name: string, language: string) {
  return (await resolveWhatsAppTemplatesForWorkspace(workspaceId)).approved(name, language);
}

async function verifyApprovedTemplate(
  lookup: (workspaceId: string, name: string, language: string) => Promise<ApprovedTemplate>,
  workspaceId: string, name: string, language: string,
) {
  try {
    return await lookup(workspaceId, name, language);
  } catch (error) {
    // All template reads precede provider dispatch. An unavailable Meta
    // approval read is a definite local suppression, never a sent-unknown.
    if (error instanceof AppError && error.status < 500) throw error;
    throw new AppError("WHATSAPP_TEMPLATE_APPROVAL_UNVERIFIED",
      "Meta template approval could not be verified; no WhatsApp message was sent.", 503);
  }
}

async function requireWhatsAppConsent(
  workspaceId: string, to: string, category: "UTILITY" | "MARKETING", requireOptIn: boolean,
) {
  let status;
  try {
    status = await getWhatsAppConsentStatus(workspaceId, to, category);
  } catch (error) {
    if (error instanceof AppError && error.status < 500) throw error;
    throw new AppError("WHATSAPP_CONSENT_UNVERIFIED",
      "WhatsApp consent could not be verified; no message was sent.", 503);
  }
  if (status === "OPTED_OUT" || (requireOptIn && status !== "OPTED_IN")) {
    throw new AppError("WHATSAPP_CONSENT_REQUIRED",
      "This customer has not opted in to this WhatsApp message type or has opted out.", 409);
  }
}

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
      input: { senderType: "AI" | "USER" | "SYSTEM"; text: string; metadata?: Record<string, unknown> },
    ) {
      const conversation = await conversationState(workspaceId, conversationId);
      if (input.senderType === "USER" && conversation.handlingMode !== "HUMAN"
        && !(await hasOpenConversationIssue(workspaceId, conversationId))) {
        throw new AppError(
          "HUMAN_TAKEOVER_REQUIRED",
          "Take over the conversation or open a staff issue before sending a staff WhatsApp reply.",
          409,
        );
      }
      if (!(await isWhatsAppCustomerWindowOpen(workspaceId, conversationId))) {
        throw new AppError("WHATSAPP_TEMPLATE_REQUIRED", "The 24-hour WhatsApp customer service window has closed. Send an approved template instead.", 409);
      }

      const runtime = await dependencies.resolveRuntime(workspaceId);
      const to = await destination(workspaceId, conversationId);
      const text = whatsappText(input.text);
      const category = classifySmsForPolicy(text, "TRANSACTIONAL") === "MARKETING"
        ? "MARKETING" as const : "UTILITY" as const;
      await requireWhatsAppConsent(workspaceId, to, category, category === "MARKETING");
      const outbound = await appendMessage(workspaceId, conversationId, {
        channel: "WHATSAPP",
        direction: "OUTBOUND",
        senderType: input.senderType,
        contentType: "TEXT",
        body: text,
        provider: "whatsapp",
        externalMessageId: null,
        status: "SENDING",
        metadata: { ...input.metadata, mode: runtime.mode, whatsappCategory: category },
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
        await requireWhatsAppConsent(workspaceId, to, category, category === "MARKETING");
      } catch (error) {
        await db.update(messages).set({ status: "SUPPRESSED",
          metadata: { ...outbound.metadata, suppressedReason:
            error instanceof AppError ? error.code : "WHATSAPP_CONSENT_UNVERIFIED" },
        }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, outbound.id)));
        throw error;
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
        senderType: "AI" | "USER" | "SYSTEM";
        templateName: string;
        languageCode: string;
        components?: unknown[];
        expectedCategory?: "UTILITY" | "MARKETING";
      },
    ) {
      const conversation = await conversationState(workspaceId, conversationId);
      if (input.senderType === "USER" && conversation.handlingMode !== "HUMAN"
        && !(await hasOpenConversationIssue(workspaceId, conversationId))) {
        throw new AppError(
          "HUMAN_TAKEOVER_REQUIRED",
          "Take over the conversation or open a staff issue before sending a staff WhatsApp template.",
          409,
        );
      }

      let runtime: WhatsAppRuntime;
      try {
        runtime = await dependencies.resolveRuntime(workspaceId);
      } catch {
        throw new AppError("WHATSAPP_NOT_CONNECTED",
          "Connect WhatsApp before sending an approved template.", 409);
      }
      const to = await destination(workspaceId, conversationId);
      const getTemplate = dependencies.getApprovedTemplate ?? approvedTemplate;
      const eligibility = await verifyApprovedTemplate(getTemplate, workspaceId, input.templateName, input.languageCode);
      if (eligibility.status !== "APPROVED"
        || !["UTILITY", "MARKETING"].includes(eligibility.category)) {
        throw new AppError("WHATSAPP_TEMPLATE_NOT_APPROVED",
          "This WhatsApp template is not currently approved.", 409);
      }
      const category = eligibility.category as "UTILITY" | "MARKETING";
      if (input.expectedCategory && input.expectedCategory !== category) {
        throw new AppError("WHATSAPP_TEMPLATE_NOT_APPROVED",
          "The template category changed since this workflow was published.", 409);
      }
      const slotCount = approvedWhatsAppParameterCount(eligibility.body);
      const component = input.components?.find((item): item is {
        type: string; parameters?: Array<{ type: string; text: string }>;
      } => Boolean(item && typeof item === "object" && "type" in item
        && (item as { type: unknown }).type === "body"));
      const params = component?.parameters ?? [];
      if (slotCount !== params.length || params.some(param =>
        param.type !== "text" || typeof param.text !== "string" || !param.text.trim())) {
        throw new AppError("WHATSAPP_TEMPLATE_VARIABLE_MISMATCH",
          "Supply one nonempty text value for each approved template placeholder.", 409);
      }
      await requireWhatsAppConsent(workspaceId, to, category, true);
      const outbound = await appendMessage(workspaceId, conversationId, {
        channel: "WHATSAPP",
        direction: "OUTBOUND",
        senderType: input.senderType,
        contentType: "TEXT",
        body: `WhatsApp template: ${input.templateName}`,
        provider: "whatsapp",
        externalMessageId: null,
        status: "SENDING",
        metadata: { mode: runtime.mode, templateName: input.templateName, languageCode: input.languageCode, templateCategory: category },
      });

      if (input.senderType === "AI") {
        const latest = await conversationState(workspaceId, conversationId);
        if (latest.handlingMode !== "AI") {
          await db.update(messages).set({ status: "SUPPRESSED",
            metadata: { ...outbound.metadata, suppressedReason: "HUMAN_TAKEOVER" },
          }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, outbound.id)));
          throw new AppError("AI_HANDLING_PAUSED", "AI reply suppressed because a human took over.", 409);
        }
      }
      // Policy failures happen before carrier dispatch; do not label them as
      // an uncertain provider send or automatically retry them.
      try {
        const current = await verifyApprovedTemplate(getTemplate, workspaceId, input.templateName, input.languageCode);
        if (current.status !== "APPROVED" || current.category !== category
          || current.body !== eligibility.body) {
          throw new AppError("WHATSAPP_TEMPLATE_NOT_APPROVED",
            "Template approval or category changed before sending.", 409);
        }
        await requireWhatsAppConsent(workspaceId, to, category, true);
      } catch (error) {
        await db.update(messages).set({ status: "SUPPRESSED",
          metadata: { ...outbound.metadata,
            suppressedReason: error instanceof AppError ? error.code : "WHATSAPP_APPROVAL_UNVERIFIED" },
        }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, outbound.id)));
        throw error;
      }
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
  input: { senderType: "AI" | "USER" | "SYSTEM"; text: string; metadata?: Record<string, unknown> },
) {
  return whatsAppOutboundService.sendText(workspaceId, conversationId, input);
}

export function sendWhatsAppConversationTemplate(
  workspaceId: string,
  conversationId: string,
  input: {
    senderType: "AI" | "USER" | "SYSTEM";
    templateName: string;
    languageCode: string;
    components?: unknown[];
    expectedCategory?: "UTILITY" | "MARKETING";
  },
) {
  return whatsAppOutboundService.sendTemplate(workspaceId, conversationId, input);
}

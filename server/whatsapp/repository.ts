import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contactIdentities, conversations, messages } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import type { WhatsAppDeliveryStatus } from "@/server/providers/contracts";

export async function attachWhatsAppProviderMessage(
  workspaceId: string,
  messageId: string,
  externalMessageId: string,
  status: "SENT",
) {
  const [updated] = await db.update(messages).set({
    provider: "whatsapp",
    externalMessageId,
    status,
    metadata: { provider: "meta" },
  }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId))).returning();
  if (!updated) throw new AppError("MESSAGE_NOT_FOUND", "WhatsApp message not found.", 404);
  return updated;
}

export async function markWhatsAppSendFailure(
  workspaceId: string,
  messageId: string,
  status: "FAILED" | "SEND_UNKNOWN",
  error: unknown,
) {
  const [existing] = await db.select().from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.id, messageId),
  )).limit(1);
  if (!existing) throw new AppError("MESSAGE_NOT_FOUND", "WhatsApp message not found.", 404);
  const message = error instanceof Error ? error.message : "WhatsApp provider send failed.";
  const [updated] = await db.update(messages).set({
    status,
    metadata: { ...existing.metadata, sendError: message.slice(0, 500) },
  }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId))).returning();
  return updated;
}

const SUCCESS_RANK: Record<Exclude<WhatsAppDeliveryStatus, "FAILED">, number> = {
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

export async function updateWhatsAppDeliveryStatus(
  workspaceId: string,
  externalMessageId: string,
  status: WhatsAppDeliveryStatus,
  error: string | null,
  occurredAt: Date | null,
) {
  const [existing] = await db.select().from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.provider, "whatsapp"),
    eq(messages.externalMessageId, externalMessageId),
  )).limit(1);
  if (!existing) return null;

  const current = existing.status as WhatsAppDeliveryStatus | "SEND_UNKNOWN" | null;
  if (current === "READ" || current === "FAILED") return existing;
  if (status === "FAILED" && (current === "DELIVERED" || current === "READ")) return existing;
  if (status !== "FAILED" && current && current in SUCCESS_RANK) {
    const currentRank = SUCCESS_RANK[current as keyof typeof SUCCESS_RANK];
    if (currentRank >= SUCCESS_RANK[status]) return existing;
  }

  const metadata = {
    ...existing.metadata,
    whatsappStatusAt: (occurredAt ?? new Date()).toISOString(),
    ...(error ? { deliveryError: error.slice(0, 500) } : {}),
  };
  const [updated] = await db.update(messages).set({ status, metadata }).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.id, existing.id),
  )).returning();
  return updated ?? existing;
}

export async function getWhatsAppConversationRecipient(workspaceId: string, conversationId: string) {
  const [row] = await db.select({ externalId: contactIdentities.externalId })
    .from(conversations)
    .innerJoin(contactIdentities, and(
      eq(contactIdentities.workspaceId, workspaceId),
      eq(contactIdentities.contactId, conversations.contactId),
      eq(contactIdentities.channel, "WHATSAPP"),
    ))
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .limit(1);
  return row?.externalId ?? null;
}

export async function latestWhatsAppInboundAt(workspaceId: string, conversationId: string) {
  const [row] = await db.select({ createdAt: messages.createdAt }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.channel, "WHATSAPP"),
    eq(messages.direction, "INBOUND"),
    eq(messages.senderType, "CUSTOMER"),
  )).orderBy(desc(messages.createdAt)).limit(1);
  return row?.createdAt ?? null;
}

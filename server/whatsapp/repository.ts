import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { contactIdentities, conversations, messages, providerWebhookEvents } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import type { WhatsAppDeliveryStatus } from "@/server/providers/contracts";
import {
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
} from "@/server/providers/webhooks/repository";

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

const DELIVERY_STATUSES = new Set<WhatsAppDeliveryStatus>(["SENT", "DELIVERED", "READ", "FAILED"]);
const STATUS_RANK_SQL = sql<number>`case ${messages.status}
  when 'SENT' then 1
  when 'DELIVERED' then 2
  when 'READ' then 3
  else 0
end`;

function metadataDate(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function updateWhatsAppDeliveryStatus(
  workspaceId: string,
  externalMessageId: string,
  status: WhatsAppDeliveryStatus,
  error: string | null,
  occurredAt: Date | null,
) {
  const effectiveOccurredAt = occurredAt ?? new Date();
  const conditions: SQL[] = [
    eq(messages.workspaceId, workspaceId),
    eq(messages.provider, "whatsapp"),
    eq(messages.externalMessageId, externalMessageId),
    sql`${messages.status} is distinct from 'FAILED'`,
    status === "FAILED"
      ? sql`${STATUS_RANK_SQL} < ${SUCCESS_RANK.DELIVERED}`
      : sql`${STATUS_RANK_SQL} < ${SUCCESS_RANK[status]}`,
  ];

  if (occurredAt) {
    conditions.push(sql`(
      ${messages.metadata}->>'whatsappStatusAt' is null
      or (${messages.metadata}->>'whatsappStatusAt')::timestamptz <= ${occurredAt}
    )`);
  }

  const metadataPatch = {
    whatsappStatusAt: effectiveOccurredAt.toISOString(),
    ...(error ? { deliveryError: error.slice(0, 500) } : {}),
  };
  const [updated] = await db.update(messages).set({
    status,
    metadata: sql<Record<string, unknown>>`${messages.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
  }).where(and(...conditions)).returning();
  if (updated) return updated;

  const [existing] = await db.select().from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.provider, "whatsapp"),
    eq(messages.externalMessageId, externalMessageId),
  )).limit(1);
  return existing ?? null;
}

function deferredOccurredAt(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function reconcileDeferredWhatsAppDeliveryStatuses(
  workspaceId: string,
  externalMessageId: string,
) {
  const events = await db.select({
    id: providerWebhookEvents.id,
    payload: providerWebhookEvents.payload,
  }).from(providerWebhookEvents).where(and(
    eq(providerWebhookEvents.workspaceId, workspaceId),
    eq(providerWebhookEvents.provider, "whatsapp"),
    eq(providerWebhookEvents.status, "RECEIVED"),
    sql`${providerWebhookEvents.payload}->>'externalMessageId' = ${externalMessageId}`,
    sql`${providerWebhookEvents.payload}->>'type' = 'DELIVERY_UPDATED'`,
  )).orderBy(asc(providerWebhookEvents.receivedAt)).limit(50);

  let reconciled = 0;
  for (const event of events) {
    const status = event.payload.status;
    if (typeof status !== "string" || !DELIVERY_STATUSES.has(status as WhatsAppDeliveryStatus)) {
      await failProviderWebhookEvent(workspaceId, event.id, new Error("Deferred WhatsApp delivery status is invalid."));
      continue;
    }
    const updated = await updateWhatsAppDeliveryStatus(
      workspaceId,
      externalMessageId,
      status as WhatsAppDeliveryStatus,
      typeof event.payload.error === "string" ? event.payload.error : null,
      deferredOccurredAt(event.payload.occurredAt),
    );
    if (!updated) break;
    await completeProviderWebhookEvent(workspaceId, event.id);
    reconciled += 1;
  }
  return reconciled;
}

function metadataWhatsAppId(metadata: Record<string, unknown>) {
  const value = metadata.whatsappWaId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function getWhatsAppConversationRecipient(workspaceId: string, conversationId: string) {
  const [latestInbound] = await db.select({ metadata: messages.metadata }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.channel, "WHATSAPP"),
    eq(messages.direction, "INBOUND"),
    eq(messages.senderType, "CUSTOMER"),
  )).orderBy(desc(messages.createdAt)).limit(1);
  const activeIdentity = latestInbound ? metadataWhatsAppId(latestInbound.metadata) : null;
  if (activeIdentity) return activeIdentity;

  const rows = await db.select({ externalId: contactIdentities.externalId })
    .from(conversations)
    .innerJoin(contactIdentities, and(
      eq(contactIdentities.workspaceId, workspaceId),
      eq(contactIdentities.contactId, conversations.contactId),
      eq(contactIdentities.channel, "WHATSAPP"),
    ))
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .limit(2);
  return rows.length === 1 ? rows[0].externalId : null;
}

function providerOccurredAt(metadata: Record<string, unknown>, fallback: Date) {
  return metadataDate(metadata, "occurredAt") ?? fallback;
}

export async function latestWhatsAppInboundAt(workspaceId: string, conversationId: string) {
  const rows = await db.select({ createdAt: messages.createdAt, metadata: messages.metadata }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.channel, "WHATSAPP"),
    eq(messages.direction, "INBOUND"),
    eq(messages.senderType, "CUSTOMER"),
  )).orderBy(desc(messages.createdAt)).limit(100);

  let latest: Date | null = null;
  for (const row of rows) {
    const occurredAt = providerOccurredAt(row.metadata, row.createdAt);
    if (!latest || occurredAt > latest) latest = occurredAt;
  }
  return latest;
}

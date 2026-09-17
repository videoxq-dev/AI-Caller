import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, providerWebhookEvents } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import type { SmsDeliveryStatus } from "@/server/providers/contracts";

export type ProviderWebhookEventInput = {
  provider: string;
  externalEventId: string;
  payload: Record<string, unknown>;
};

export async function claimProviderWebhookEvent(workspaceId: string, input: ProviderWebhookEventInput) {
  const [created] = await db.insert(providerWebhookEvents).values({
    workspaceId,
    provider: input.provider,
    externalEventId: input.externalEventId,
    payload: input.payload,
    status: "RECEIVED",
  }).onConflictDoNothing().returning({ id: providerWebhookEvents.id });

  if (created) return { state: "claimed" as const, eventId: created.id, status: "RECEIVED" as const, payload: input.payload };

  const [existing] = await db.select({
    id: providerWebhookEvents.id,
    status: providerWebhookEvents.status,
    payload: providerWebhookEvents.payload,
  }).from(providerWebhookEvents).where(and(
    eq(providerWebhookEvents.workspaceId, workspaceId),
    eq(providerWebhookEvents.provider, input.provider),
    eq(providerWebhookEvents.externalEventId, input.externalEventId),
  )).limit(1);

  if (!existing) throw new AppError("WEBHOOK_CONFLICT", "The provider webhook could not be claimed.", 409);
  return { state: "duplicate" as const, eventId: existing.id, status: existing.status, payload: existing.payload };
}

export async function markProviderWebhookQueued(workspaceId: string, eventId: string, payload: Record<string, unknown>) {
  const [updated] = await db.update(providerWebhookEvents).set({
    status: "QUEUED",
    payload,
    error: null,
    processedAt: null,
  }).where(and(
    eq(providerWebhookEvents.workspaceId, workspaceId),
    eq(providerWebhookEvents.id, eventId),
    eq(providerWebhookEvents.status, "RECEIVED"),
  )).returning();
  return updated ?? null;
}

export async function claimQueuedProviderWebhookEvent(workspaceId: string, eventId: string) {
  const [updated] = await db.update(providerWebhookEvents).set({ status: "PROCESSING", error: null, processedAt: null }).where(and(
    eq(providerWebhookEvents.workspaceId, workspaceId),
    eq(providerWebhookEvents.id, eventId),
    eq(providerWebhookEvents.status, "QUEUED"),
  )).returning();
  return updated ?? null;
}

export async function completeProviderWebhookEvent(workspaceId: string, eventId: string) {
  const [updated] = await db.update(providerWebhookEvents).set({
    status: "PROCESSED",
    error: null,
    processedAt: new Date(),
  }).where(and(eq(providerWebhookEvents.workspaceId, workspaceId), eq(providerWebhookEvents.id, eventId))).returning();
  if (!updated) throw new AppError("WEBHOOK_NOT_FOUND", "Provider webhook event not found.", 404);
  return updated;
}

export async function failProviderWebhookEvent(workspaceId: string, eventId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Provider webhook processing failed.";
  const [updated] = await db.update(providerWebhookEvents).set({
    status: "FAILED",
    error: message.slice(0, 500),
    processedAt: new Date(),
  }).where(and(eq(providerWebhookEvents.workspaceId, workspaceId), eq(providerWebhookEvents.id, eventId))).returning();
  if (!updated) throw new AppError("WEBHOOK_NOT_FOUND", "Provider webhook event not found.", 404);
  return updated;
}

export async function attachSmsProviderMessage(
  workspaceId: string,
  messageId: string,
  provider: string,
  externalMessageId: string,
  status: SmsDeliveryStatus,
) {
  const [updated] = await db.update(messages).set({ provider, externalMessageId, status }).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.id, messageId),
  )).returning();
  if (!updated) throw new AppError("MESSAGE_NOT_FOUND", "SMS message not found.", 404);
  return updated;
}

export async function markSmsSendFailure(workspaceId: string, messageId: string, status: "FAILED" | "SEND_UNKNOWN", error: unknown) {
  const message = error instanceof Error ? error.message : "SMS provider send failed.";
  const [existing] = await db.select().from(messages).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId))).limit(1);
  if (!existing) throw new AppError("MESSAGE_NOT_FOUND", "SMS message not found.", 404);
  const [updated] = await db.update(messages).set({
    status,
    metadata: { ...existing.metadata, sendError: message.slice(0, 500) },
  }).where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId))).returning();
  return updated;
}

const DELIVERY_RANK: Record<SmsDeliveryStatus, number> = { QUEUED: 1, SENT: 2, DELIVERED: 3, FAILED: 4 };

export async function updateSmsDeliveryStatus(
  workspaceId: string,
  provider: string,
  externalMessageId: string,
  status: SmsDeliveryStatus,
  error: string | null,
) {
  const [existing] = await db.select().from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.provider, provider),
    eq(messages.externalMessageId, externalMessageId),
  )).limit(1);
  if (!existing) return null;

  const current = existing.status as SmsDeliveryStatus | null;
  if (current === "DELIVERED" || current === "FAILED") return existing;
  if (current && current in DELIVERY_RANK && DELIVERY_RANK[current] > DELIVERY_RANK[status]) return existing;

  const metadata = error ? { ...existing.metadata, deliveryError: error } : existing.metadata;
  const [updated] = await db.update(messages).set({ status, metadata }).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.id, existing.id),
  )).returning();
  return updated ?? existing;
}

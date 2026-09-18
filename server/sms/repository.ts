import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import type { SmsDeliveryStatus } from "@/server/providers/contracts";

export {
  claimProviderWebhookEvent,
  claimQueuedProviderWebhookEvent,
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
  markProviderWebhookQueued,
  releaseProviderWebhookEventForRetry,
  type ProviderWebhookEventInput,
} from "@/server/providers/webhooks/repository";

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

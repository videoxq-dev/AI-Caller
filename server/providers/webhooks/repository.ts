import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { providerWebhookEvents } from "@/db/schema";
import { AppError } from "@/server/http/errors";

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

export async function releaseProviderWebhookEventForRetry(workspaceId: string, eventId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Provider webhook processing failed.";
  const [updated] = await db.update(providerWebhookEvents).set({
    status: "QUEUED",
    error: message.slice(0, 500),
    processedAt: null,
  }).where(and(
    eq(providerWebhookEvents.workspaceId, workspaceId),
    eq(providerWebhookEvents.id, eventId),
    eq(providerWebhookEvents.status, "PROCESSING"),
  )).returning();
  if (!updated) throw new AppError("WEBHOOK_RETRY_CONFLICT", "Provider webhook event could not be released for retry.", 409);
  return updated;
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

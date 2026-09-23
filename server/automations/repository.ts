import { and, asc, desc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { automationDeliveries, automationEvents, automationRuns, automationSettings, memberships } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import {
  automationKeys,
  defaultAutomationConfig,
  parseAutomationConfig,
  type AutomationConfigMap,
  type AutomationKey,
} from "./schemas";

export type AutomationSettingRecord<K extends AutomationKey = AutomationKey> = {
  key: K;
  enabled: boolean;
  config: AutomationConfigMap[K];
};

export async function listAutomationSettings(workspaceId: string): Promise<AutomationSettingRecord[]> {
  const rows = await db.select().from(automationSettings)
    .where(eq(automationSettings.workspaceId, workspaceId))
    .orderBy(asc(automationSettings.key));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return automationKeys.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      enabled: row?.enabled ?? false,
      config: parseAutomationConfig(key, row?.config ?? {}),
    } as AutomationSettingRecord;
  });
}

export async function getAutomationSetting<K extends AutomationKey>(
  workspaceId: string,
  key: K,
): Promise<AutomationSettingRecord<K>> {
  const [row] = await db.select().from(automationSettings).where(and(
    eq(automationSettings.workspaceId, workspaceId),
    eq(automationSettings.key, key),
  )).limit(1);
  return {
    key,
    enabled: row?.enabled ?? false,
    config: parseAutomationConfig(key, row?.config ?? defaultAutomationConfig(key)),
  };
}

export async function saveAutomationSetting<K extends AutomationKey>(
  workspaceId: string,
  key: K,
  input: { enabled: boolean; config: unknown },
): Promise<AutomationSettingRecord<K>> {
  const config = parseAutomationConfig(key, input.config);
  if (key === "QUALIFIED_LEAD_ASSIGNMENT" || key === "HUMAN_ESCALATION") {
    const assignedUserId = (config as { assignedUserId: string | null }).assignedUserId;
    if (assignedUserId) {
      const [membership] = await db.select({ userId: memberships.userId })
        .from(memberships)
        .where(and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, assignedUserId),
        ))
        .limit(1);
      if (!membership) {
        throw new AppError(
          "AUTOMATION_ASSIGNEE_INVALID",
          "Automation assignee must be a current workspace member.",
          400,
        );
      }
    }
  }
  await db.insert(automationSettings).values({
    workspaceId,
    key,
    enabled: input.enabled,
    config,
  }).onConflictDoUpdate({
    target: [automationSettings.workspaceId, automationSettings.key],
    set: { enabled: input.enabled, config, updatedAt: new Date() },
  });
  return { key, enabled: input.enabled, config };
}

export async function getAutomationEvent(workspaceId: string, eventId: string) {
  const [event] = await db.select().from(automationEvents).where(and(
    eq(automationEvents.workspaceId, workspaceId),
    eq(automationEvents.id, eventId),
  )).limit(1);
  return event ?? null;
}

export async function createAutomationRun(input: {
  workspaceId: string;
  eventId: string;
  key: AutomationKey;
  occurrenceKey?: string;
  scheduledFor?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  const occurrenceKey = input.occurrenceKey ?? "default";
  const [created] = await db.insert(automationRuns).values({
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    key: input.key,
    occurrenceKey,
    scheduledFor: input.scheduledFor ?? null,
    metadata: input.metadata ?? {},
  }).onConflictDoNothing().returning();
  if (created) return created;

  const [existing] = await db.select().from(automationRuns).where(and(
    eq(automationRuns.eventId, input.eventId),
    eq(automationRuns.key, input.key),
    eq(automationRuns.occurrenceKey, occurrenceKey),
  )).limit(1);
  if (!existing) throw new AppError("AUTOMATION_RUN_CONFLICT", "Automation run could not be resolved.", 409);
  return existing;
}

export async function createWorkflowRun(input: {
  workspaceId: string;
  eventId: string;
  workflowVersionId: string;
}) {
  // Event identity and version identity both belong to the workspace.
  const event = await getAutomationEvent(input.workspaceId, input.eventId);
  if (!event) throw new AppError("AUTOMATION_EVENT_NOT_FOUND", "Automation event not found.", 404);
  const [created] = await db.insert(automationRuns).values({
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    key: null,
    workflowVersionId: input.workflowVersionId,
    occurrenceKey: "default",
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await db.select().from(automationRuns).where(and(
    eq(automationRuns.workspaceId, input.workspaceId),
    eq(automationRuns.eventId, input.eventId),
    eq(automationRuns.workflowVersionId, input.workflowVersionId),
    eq(automationRuns.occurrenceKey, "default"),
  )).limit(1);
  if (!existing) throw new AppError("AUTOMATION_RUN_CONFLICT", "Workflow run could not be resolved.", 409);
  return existing;
}

export async function markAutomationEventDispatched(workspaceId: string, eventId: string) {
  await db.update(automationEvents).set({ dispatchedAt: new Date() }).where(and(
    eq(automationEvents.workspaceId, workspaceId),
    eq(automationEvents.id, eventId),
  ));
}

export async function listUndispatchedAutomationEvents(limit = 100) {
  return db.select().from(automationEvents)
    .where(isNull(automationEvents.dispatchedAt))
    .orderBy(asc(automationEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export async function claimAutomationRun(workspaceId: string, runId: string) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 2 * 60_000);
  const [run] = await db.update(automationRuns).set({
    status: "RUNNING",
    startedAt: now,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
  }).where(and(
    eq(automationRuns.workspaceId, workspaceId),
    eq(automationRuns.id, runId),
    or(isNull(automationRuns.scheduledFor), lte(automationRuns.scheduledFor, now)),
    or(
      eq(automationRuns.status, "PENDING"),
      and(eq(automationRuns.status, "RUNNING"), lt(automationRuns.startedAt, staleBefore)),
    ),
  )).returning();
  return run ?? null;
}

export async function releaseAutomationRunForRetry(workspaceId: string, runId: string) {
  const [run] = await db.update(automationRuns).set({
    status: "PENDING",
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
  }).where(and(
    eq(automationRuns.workspaceId, workspaceId),
    eq(automationRuns.id, runId),
    eq(automationRuns.status, "RUNNING"),
  )).returning();
  return run ?? null;
}

export async function completeAutomationRun(
  workspaceId: string,
  runId: string,
  status: "COMPLETED" | "SKIPPED",
  metadata?: Record<string, unknown>,
) {
  const [run] = await db.update(automationRuns).set({
    status,
    completedAt: new Date(),
    ...(metadata ? { metadata } : {}),
  }).where(and(
    eq(automationRuns.workspaceId, workspaceId),
    eq(automationRuns.id, runId),
    eq(automationRuns.status, "RUNNING"),
  )).returning();
  return run ?? null;
}

export async function failAutomationRun(
  workspaceId: string,
  runId: string,
  error: unknown,
  metadata?: Record<string, unknown>,
) {
  const code = error instanceof AppError ? error.code : "AUTOMATION_FAILED";
  const message = error instanceof Error ? error.message : "Automation execution failed.";
  const [run] = await db.update(automationRuns).set({
    status: "FAILED",
    completedAt: new Date(),
    errorCode: code,
    errorMessage: message.slice(0, 1000),
    ...(metadata ? { metadata } : {}),
  }).where(and(
    eq(automationRuns.workspaceId, workspaceId),
    eq(automationRuns.id, runId),
    eq(automationRuns.status, "RUNNING"),
  )).returning();
  return run ?? null;
}

export async function getAutomationRun(workspaceId: string, runId: string) {
  const [run] = await db.select().from(automationRuns).where(and(
    eq(automationRuns.workspaceId, workspaceId),
    eq(automationRuns.id, runId),
  )).limit(1);
  return run ?? null;
}

export async function listAutomationActivity(workspaceId: string, limit = 100) {
  return db.select({
    run: automationRuns,
    event: automationEvents,
  }).from(automationRuns)
    .innerJoin(automationEvents, eq(automationRuns.eventId, automationEvents.id))
    .where(eq(automationRuns.workspaceId, workspaceId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}


export async function claimAutomationDelivery(input: {
  workspaceId: string;
  runId: string;
  channel: string;
  recipient: string;
}) {
  const [created] = await db.insert(automationDeliveries).values({
    workspaceId: input.workspaceId,
    runId: input.runId,
    channel: input.channel,
    recipient: input.recipient,
  }).onConflictDoNothing().returning();
  if (created) return { delivery: created, created: true as const };

  const [existing] = await db.select().from(automationDeliveries).where(and(
    eq(automationDeliveries.runId, input.runId),
    eq(automationDeliveries.channel, input.channel),
    eq(automationDeliveries.recipient, input.recipient),
  )).limit(1);
  if (!existing) throw new AppError("AUTOMATION_DELIVERY_CONFLICT", "Automation delivery could not be resolved.", 409);
  return { delivery: existing, created: false as const };
}

export async function finishAutomationDelivery(
  workspaceId: string,
  deliveryId: string,
  input: {
    status: "SENT" | "SKIPPED" | "FAILED" | "UNKNOWN";
    messageId?: string | null;
    providerExternalId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
) {
  const [delivery] = await db.update(automationDeliveries).set({
    status: input.status,
    messageId: input.messageId ?? null,
    providerExternalId: input.providerExternalId ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage?.slice(0, 1000) ?? null,
    updatedAt: new Date(),
  }).where(and(
    eq(automationDeliveries.workspaceId, workspaceId),
    eq(automationDeliveries.id, deliveryId),
  )).returning();
  if (!delivery) throw new AppError("AUTOMATION_DELIVERY_NOT_FOUND", "Automation delivery not found.", 404);
  return delivery;
}

export async function listAutomationDeliveries(workspaceId: string, runId: string) {
  return db.select().from(automationDeliveries).where(and(
    eq(automationDeliveries.workspaceId, workspaceId),
    eq(automationDeliveries.runId, runId),
  )).orderBy(asc(automationDeliveries.createdAt));
}


export async function listRecoverableAutomationRuns(limit = 100) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 2 * 60_000);
  return db.select().from(automationRuns).where(and(
    or(isNull(automationRuns.scheduledFor), lte(automationRuns.scheduledFor, now)),
    or(
      eq(automationRuns.status, "PENDING"),
      and(eq(automationRuns.status, "RUNNING"), lt(automationRuns.startedAt, staleBefore)),
    ),
  )).orderBy(asc(automationRuns.createdAt)).limit(Math.min(Math.max(limit, 1), 500));
}

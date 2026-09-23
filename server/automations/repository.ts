import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  automationDeliveries,
  automationEvents,
  automationRuns,
  automationSettings,
  memberships,
  workflowActionRuns,
  workflowDefinitions,
  workflowVersions,
} from "@/db/schema";
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
  actions: Array<{ type: string }>;
}) {
  if (input.actions.length < 1 || input.actions.length > 5) {
    throw new AppError("WORKFLOW_ACTION_LIMIT", "Workflow run requires between one and five actions.", 400);
  }
  return db.transaction(async tx => {
    const [event] = await tx.select({ id: automationEvents.id }).from(automationEvents).where(and(
      eq(automationEvents.workspaceId, input.workspaceId),
      eq(automationEvents.id, input.eventId),
    )).limit(1);
    if (!event) throw new AppError("AUTOMATION_EVENT_NOT_FOUND", "Automation event not found.", 404);

    // Serialize against publish/pause/archive. If pause wins the lock, no new
    // queued run is created. If dispatch wins, the later pause sweep sees and
    // cancels this run before it can start.
    const [activeVersion] = await tx.select({
      versionId: workflowVersions.id,
      status: workflowDefinitions.status,
    }).from(workflowVersions)
      .innerJoin(workflowDefinitions, and(
        eq(workflowDefinitions.workspaceId, workflowVersions.workspaceId),
        eq(workflowDefinitions.id, workflowVersions.definitionId),
      ))
      .where(and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.id, input.workflowVersionId),
      )).for("update").limit(1);
    if (!activeVersion) {
      throw new AppError("WORKFLOW_VERSION_INVALID", "Workflow version does not belong to this workspace.", 409);
    }
    if (activeVersion.status !== "PUBLISHED") return null;

    const [created] = await tx.insert(automationRuns).values({
      workspaceId: input.workspaceId,
      eventId: input.eventId,
      key: null,
      workflowVersionId: input.workflowVersionId,
      occurrenceKey: "default",
    }).onConflictDoNothing().returning();

    let run = created;
    if (!run) {
      [run] = await tx.select().from(automationRuns).where(and(
        eq(automationRuns.workspaceId, input.workspaceId),
        eq(automationRuns.eventId, input.eventId),
        eq(automationRuns.workflowVersionId, input.workflowVersionId),
        eq(automationRuns.occurrenceKey, "default"),
      )).limit(1);
    }
    if (!run) throw new AppError("AUTOMATION_RUN_CONFLICT", "Workflow run could not be resolved.", 409);

    await tx.insert(workflowActionRuns).values(input.actions.map((action, actionIndex) => ({
      workspaceId: input.workspaceId,
      automationRunId: run.id,
      actionIndex,
      actionType: action.type,
    }))).onConflictDoNothing();

    const persisted = await tx.select().from(workflowActionRuns).where(and(
      eq(workflowActionRuns.workspaceId, input.workspaceId),
      eq(workflowActionRuns.automationRunId, run.id),
    )).orderBy(asc(workflowActionRuns.actionIndex));
    if (persisted.length !== input.actions.length
      || persisted.some((row, index) => row.actionIndex !== index || row.actionType !== input.actions[index]?.type)) {
      throw new AppError(
        "WORKFLOW_ACTION_LEDGER_CONFLICT",
        "Workflow action ledger does not match its immutable workflow version.",
        409,
      );
    }
    return run;
  });
}

export async function listWorkflowActionRuns(workspaceId: string, runId: string) {
  return db.select().from(workflowActionRuns).where(and(
    eq(workflowActionRuns.workspaceId, workspaceId),
    eq(workflowActionRuns.automationRunId, runId),
  )).orderBy(asc(workflowActionRuns.actionIndex));
}

export async function claimWorkflowActionRun(workspaceId: string, runId: string, actionIndex: number) {
  const now = new Date();
  // Action side effects may legitimately outlive the run recovery lease.
  // Keep action ownership for the full pg-boss job expiry window before reclaiming.
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const [action] = await db.update(workflowActionRuns).set({
    status: "RUNNING",
    startedAt: now,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: sql`${workflowActionRuns.attemptCount} + 1`,
    updatedAt: now,
  }).where(and(
    eq(workflowActionRuns.workspaceId, workspaceId),
    eq(workflowActionRuns.automationRunId, runId),
    eq(workflowActionRuns.actionIndex, actionIndex),
    or(
      eq(workflowActionRuns.status, "PENDING"),
      and(eq(workflowActionRuns.status, "RUNNING"), lt(workflowActionRuns.startedAt, staleBefore)),
    ),
  )).returning();
  return action ?? null;
}

export async function releaseWorkflowActionRunForRetry(workspaceId: string, actionRunId: string) {
  const [action] = await db.update(workflowActionRuns).set({
    status: "PENDING",
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    updatedAt: new Date(),
  }).where(and(
    eq(workflowActionRuns.workspaceId, workspaceId),
    eq(workflowActionRuns.id, actionRunId),
    eq(workflowActionRuns.status, "RUNNING"),
  )).returning();
  return action ?? null;
}

export async function finishWorkflowActionRun(
  workspaceId: string,
  actionRunId: string,
  input: {
    status: "COMPLETED" | "SKIPPED" | "FAILED" | "UNKNOWN" | "CANCELLED";
    errorCode?: string | null;
    errorMessage?: string | null;
    result?: Record<string, unknown>;
  },
) {
  const [action] = await db.update(workflowActionRuns).set({
    status: input.status,
    completedAt: new Date(),
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage?.slice(0, 1000) ?? null,
    result: input.result ?? {},
    updatedAt: new Date(),
  }).where(and(
    eq(workflowActionRuns.workspaceId, workspaceId),
    eq(workflowActionRuns.id, actionRunId),
    eq(workflowActionRuns.status, "RUNNING"),
  )).returning();
  return action ?? null;
}

export async function cancelPendingWorkflowActions(
  workspaceId: string,
  runId: string,
  reason: string,
) {
  return db.update(workflowActionRuns).set({
    status: "CANCELLED",
    completedAt: new Date(),
    errorCode: "WORKFLOW_CANCELLED",
    errorMessage: reason.slice(0, 1000),
    updatedAt: new Date(),
  }).where(and(
    eq(workflowActionRuns.workspaceId, workspaceId),
    eq(workflowActionRuns.automationRunId, runId),
    eq(workflowActionRuns.status, "PENDING"),
  )).returning();
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

export async function cancelAutomationRun(
  workspaceId: string,
  runId: string,
  reason: string,
) {
  const [run] = await db.update(automationRuns).set({
    status: "CANCELLED",
    completedAt: new Date(),
    errorCode: "WORKFLOW_CANCELLED",
    errorMessage: reason.slice(0, 1000),
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
  const rows = await db.select({
    run: automationRuns,
    event: automationEvents,
    workflow: {
      definitionId: workflowVersions.definitionId,
      version: workflowVersions.version,
      name: workflowDefinitions.name,
    },
  }).from(automationRuns)
    .innerJoin(automationEvents, eq(automationRuns.eventId, automationEvents.id))
    .leftJoin(workflowVersions, and(
      eq(workflowVersions.workspaceId, workspaceId),
      eq(workflowVersions.id, automationRuns.workflowVersionId),
    ))
    .leftJoin(workflowDefinitions, and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.id, workflowVersions.definitionId),
    ))
    .where(eq(automationRuns.workspaceId, workspaceId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));

  const runIds = rows.map(row => row.run.id);
  if (!runIds.length) return [];
  const [actions, deliveries] = await Promise.all([
    db.select().from(workflowActionRuns).where(and(
      eq(workflowActionRuns.workspaceId, workspaceId),
      inArray(workflowActionRuns.automationRunId, runIds),
    )).orderBy(asc(workflowActionRuns.actionIndex)),
    db.select().from(automationDeliveries).where(and(
      eq(automationDeliveries.workspaceId, workspaceId),
      inArray(automationDeliveries.runId, runIds),
    )).orderBy(asc(automationDeliveries.createdAt)),
  ]);
  const actionsByRun = new Map<string, typeof actions>();
  const deliveriesByRun = new Map<string, typeof deliveries>();
  for (const action of actions) {
    const bucket = actionsByRun.get(action.automationRunId) ?? [];
    bucket.push(action);
    actionsByRun.set(action.automationRunId, bucket);
  }
  for (const delivery of deliveries) {
    const bucket = deliveriesByRun.get(delivery.runId) ?? [];
    bucket.push(delivery);
    deliveriesByRun.set(delivery.runId, bucket);
  }
  return rows.map(row => ({
    ...row,
    actions: actionsByRun.get(row.run.id) ?? [],
    deliveries: deliveriesByRun.get(row.run.id) ?? [],
  }));
}


export async function claimAutomationDelivery(input: {
  workspaceId: string;
  runId: string;
  actionRunId?: string | null;
  channel: string;
  recipient: string;
}) {
  const actionRunId = input.actionRunId ?? null;
  const [created] = await db.insert(automationDeliveries).values({
    workspaceId: input.workspaceId,
    runId: input.runId,
    actionRunId,
    channel: input.channel,
    recipient: input.recipient,
  }).onConflictDoNothing().returning();
  if (created) return { delivery: created, created: true as const };

  const [existing] = await db.select().from(automationDeliveries).where(and(
    eq(automationDeliveries.workspaceId, input.workspaceId),
    eq(automationDeliveries.runId, input.runId),
    actionRunId
      ? eq(automationDeliveries.actionRunId, actionRunId)
      : isNull(automationDeliveries.actionRunId),
    eq(automationDeliveries.channel, input.channel),
    eq(automationDeliveries.recipient, input.recipient),
  )).limit(1);
  if (!existing) throw new AppError("AUTOMATION_DELIVERY_CONFLICT", "Automation delivery could not be resolved.", 409);
  return { delivery: existing, created: false as const };
}

export async function getAutomationDelivery(workspaceId: string, deliveryId: string) {
  const [delivery] = await db.select().from(automationDeliveries).where(and(
    eq(automationDeliveries.workspaceId, workspaceId),
    eq(automationDeliveries.id, deliveryId),
  )).limit(1);
  return delivery ?? null;
}

export async function listWorkflowActionDeliveries(workspaceId: string, actionRunId: string) {
  return db.select().from(automationDeliveries).where(and(
    eq(automationDeliveries.workspaceId, workspaceId),
    eq(automationDeliveries.actionRunId, actionRunId),
  )).orderBy(asc(automationDeliveries.createdAt));
}

export async function finishPendingAutomationDelivery(
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
    eq(automationDeliveries.status, "PENDING"),
  )).returning();
  return delivery ?? null;
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

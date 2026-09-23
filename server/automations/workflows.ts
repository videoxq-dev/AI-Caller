import { and, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  automationEvents,
  automationEventType,
  automationRuns,
  workflowActionRuns,
  workflowDefinitions,
  workflowStatusHistory,
  workflowVersions,
  workspaces,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import {
  actionAllowedForTrigger,
  MAX_WORKFLOW_ACTIONS,
  validateWorkflowActionsForPublication,
  workflowActionSchema,
} from "./action-registry";

// This is deliberately a closed, typed registry. No arbitrary payload paths,
// user scripts, network endpoints, or editable execution mode.
const comparison = z.enum(["EQ", "GTE", "LTE"]);
const conditionSchema = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("qualificationScore"),
    operator: comparison,
    value: z.number().finite().min(0).max(100),
  }).strict(),
  z.object({
    field: z.literal("revision"),
    operator: comparison,
    value: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    field: z.literal("channel"),
    operator: z.literal("EQ"),
    value: z.enum(["PHONE", "SMS", "WHATSAPP", "WEBCHAT"]),
  }).strict(),
]);

export const workflowDefinitionSchema = z.object({
  trigger: z.enum(automationEventType.enumValues),
  match: z.enum(["ALL", "ANY"]).default("ALL"),
  conditions: z.array(conditionSchema).max(10).default([]),
  actions: z.array(workflowActionSchema).min(1).max(MAX_WORKFLOW_ACTIONS),
}).strict().superRefine((draft, ctx) => {
  for (const [index, condition] of draft.conditions.entries()) {
    const allowed = condition.field === "qualificationScore"
      ? draft.trigger === "LEAD_QUALIFIED"
      : condition.field === "channel"
        ? draft.trigger === "INQUIRY_RECEIVED"
        : draft.trigger === "APPOINTMENT_CONFIRMED"
          || draft.trigger === "APPOINTMENT_RESCHEDULED"
          || draft.trigger === "APPOINTMENT_CANCELLED";
    if (!allowed) ctx.addIssue({
      code: "custom",
      path: ["conditions", index, "field"],
      message: "This field is not available for the selected trigger.",
    });
  }
  for (const [index, action] of draft.actions.entries()) {
    if (!actionAllowedForTrigger(draft.trigger, action)) {
      ctx.addIssue({
        code: "custom",
        path: ["actions", index, "type"],
        message: `${action.type} cannot run for ${draft.trigger} events.`,
      });
    }
  }
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
type WorkflowEvent = {
  type: typeof automationEventType.enumValues[number];
  payload: Record<string, unknown>;
};

export function matchesWorkflow(definition: WorkflowDefinition, event: WorkflowEvent) {
  if (definition.trigger !== event.type) return false;
  if (definition.conditions.length === 0) return true;
  const results = definition.conditions.map(condition => {
    const actual = event.payload[condition.field];
    if (typeof actual !== typeof condition.value) return false;
    if (condition.operator === "EQ") return actual === condition.value;
    if (typeof actual !== "number" || !Number.isFinite(actual)
      || typeof condition.value !== "number") return false;
    return condition.operator === "GTE"
      ? actual >= condition.value
      : actual <= condition.value;
  });
  return definition.match === "ALL" ? results.every(Boolean) : results.some(Boolean);
}

export async function createWorkflowDraft(workspaceId: string, name: string, input: unknown) {
  const draft = workflowDefinitionSchema.parse(input);
  const cleanName = z.string().trim().min(1).max(120).parse(name);
  const [created] = await db.insert(workflowDefinitions).values({
    workspaceId, name: cleanName, draft,
  }).returning();
  return created;
}

export async function updateWorkflowDraft(workspaceId: string, definitionId: string, name: string, input: unknown) {
  const draft = workflowDefinitionSchema.parse(input);
  const cleanName = z.string().trim().min(1).max(120).parse(name);
  const [updated] = await db.update(workflowDefinitions).set({
    name: cleanName, draft, updatedAt: new Date(),
  }).where(and(
    eq(workflowDefinitions.id, definitionId),
    eq(workflowDefinitions.workspaceId, workspaceId),
    // Editing a published workflow leaves the active immutable version untouched.
    // Archived workflows cannot be silently resurrected.
    ne(workflowDefinitions.status, "ARCHIVED"),
  )).returning();
  if (!updated) throw new AppError("WORKFLOW_NOT_EDITABLE", "Workflow not found or archived.", 404);
  return updated;
}

export async function publishWorkflow(workspaceId: string, definitionId: string) {
  return db.transaction(async tx => {
    // Serialize publication within the workspace so the dispatcher cap cannot
    // be exceeded by two simultaneous publish operations.
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces)
      .where(eq(workspaces.id, workspaceId)).for("update").limit(1);
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "Workspace not found.", 404);
    const [definition] = await tx.select().from(workflowDefinitions).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.id, definitionId),
    )).for("update").limit(1);
    if (!definition || definition.status === "ARCHIVED") {
      throw new AppError("WORKFLOW_NOT_EDITABLE", "Workflow not found or archived.", 404);
    }
    const snapshot = workflowDefinitionSchema.parse(definition.draft);
    await validateWorkflowActionsForPublication({
      workspaceId,
      trigger: snapshot.trigger,
      actions: snapshot.actions,
    });
    if (definition.publishedVersion && definition.status === "PUBLISHED") {
      const [current] = await tx.select().from(workflowVersions).where(and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.definitionId, definitionId),
        eq(workflowVersions.version, definition.publishedVersion),
      )).limit(1);
      // PostgreSQL jsonb normalizes object-key order. Compare normalized,
      // validated definitions rather than raw JSON serialization.
      const previous = current ? workflowDefinitionSchema.safeParse(current.snapshot) : null;
      if (previous?.success && JSON.stringify(previous.data) === JSON.stringify(snapshot)) return current;
    }
    if (definition.status !== "PUBLISHED") {
      const published = await tx.select({ id: workflowDefinitions.id }).from(workflowDefinitions)
        .where(and(
          eq(workflowDefinitions.workspaceId, workspaceId),
          eq(workflowDefinitions.status, "PUBLISHED"),
        )).limit(200);
      if (published.length >= 200) {
        throw new AppError("WORKFLOW_LIMIT_EXCEEDED", "This workspace has reached its published workflow limit.", 409);
      }
    }
    const nextVersion = (definition.publishedVersion ?? 0) + 1;
    const publishedAt = new Date();
    const [version] = await tx.insert(workflowVersions).values({
      workspaceId, definitionId, version: nextVersion, snapshot, publishedAt,
    }).returning();
    await tx.update(workflowDefinitions).set({
      status: "PUBLISHED", publishedVersion: nextVersion, updatedAt: publishedAt,
    }).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.id, definitionId),
    ));
    if (definition.status !== "PUBLISHED") {
      await tx.insert(workflowStatusHistory).values({
        workspaceId, definitionId, status: "PUBLISHED", occurredAt: publishedAt,
      });
    }
    return version;
  });
}

export async function setWorkflowStatus(
  workspaceId: string,
  definitionId: string,
  status: "PUBLISHED" | "PAUSED" | "ARCHIVED",
) {
  return db.transaction(async tx => {
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces)
      .where(eq(workspaces.id, workspaceId)).for("update").limit(1);
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "Workspace not found.", 404);
    const [definition] = await tx.select().from(workflowDefinitions).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.id, definitionId),
    )).for("update").limit(1);
    if (!definition || !["PUBLISHED", "PAUSED"].includes(definition.status)
      || !definition.publishedVersion) {
      throw new AppError("WORKFLOW_STATUS_CONFLICT", "Publish this workflow before changing its status.", 409);
    }
    if (status === "PUBLISHED" && definition.status === "PAUSED") {
      const published = await tx.select({ id: workflowDefinitions.id }).from(workflowDefinitions)
        .where(and(
          eq(workflowDefinitions.workspaceId, workspaceId),
          eq(workflowDefinitions.status, "PUBLISHED"),
        )).limit(200);
      if (published.length >= 200) {
        throw new AppError("WORKFLOW_LIMIT_EXCEEDED", "This workspace has reached its published workflow limit.", 409);
      }
    }
    if (status === definition.status) return definition;

    const now = new Date();
    const [updated] = await tx.update(workflowDefinitions).set({
      status, updatedAt: now,
    }).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.id, definitionId),
    )).returning();

    await tx.insert(workflowStatusHistory).values({
      workspaceId,
      definitionId,
      status,
      occurredAt: now,
    });

    if (status !== "PUBLISHED") {
      const versions = await tx.select({ id: workflowVersions.id }).from(workflowVersions).where(and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.definitionId, definitionId),
      ));
      const versionIds = versions.map(row => row.id);
      if (versionIds.length) {
        const pendingRuns = await tx.update(automationRuns).set({
          status: "CANCELLED",
          completedAt: now,
          errorCode: status === "PAUSED" ? "WORKFLOW_PAUSED" : "WORKFLOW_ARCHIVED",
          errorMessage: status === "PAUSED"
            ? "Workflow was paused before this run started."
            : "Workflow was archived before this run started.",
        }).where(and(
          eq(automationRuns.workspaceId, workspaceId),
          inArray(automationRuns.workflowVersionId, versionIds),
          eq(automationRuns.status, "PENDING"),
        )).returning({ id: automationRuns.id });

        const runningRuns = await tx.update(automationRuns).set({
          cancelRequestedAt: now,
        }).where(and(
          eq(automationRuns.workspaceId, workspaceId),
          inArray(automationRuns.workflowVersionId, versionIds),
          eq(automationRuns.status, "RUNNING"),
        )).returning({ id: automationRuns.id });

        const affectedRunIds = [...pendingRuns, ...runningRuns].map(row => row.id);
        if (affectedRunIds.length) {
          await tx.update(workflowActionRuns).set({
            status: "CANCELLED",
            completedAt: now,
            errorCode: status === "PAUSED" ? "WORKFLOW_PAUSED" : "WORKFLOW_ARCHIVED",
            errorMessage: status === "PAUSED"
              ? "Workflow was paused before this action started."
              : "Workflow was archived before this action started.",
            updatedAt: now,
          }).where(and(
            eq(workflowActionRuns.workspaceId, workspaceId),
            inArray(workflowActionRuns.automationRunId, affectedRunIds),
            eq(workflowActionRuns.status, "PENDING"),
          ));
        }
      }
    }
    return updated;
  });
}

export async function listPublishedWorkflowVersions(workspaceId: string, eventId?: string) {
  // Keep event/version/status comparisons at PostgreSQL precision. JS Date truncates
  // PostgreSQL microseconds and can move a boundary event across a publish/pause edge.
  const occurrence = eventId
    ? sql<Date>`(SELECT ${automationEvents.occurredAt} FROM ${automationEvents} WHERE ${automationEvents.id} = ${eventId} AND ${automationEvents.workspaceId} = ${workspaceId})`
    : sql<Date>`now()`;

  const rows = await db.selectDistinctOn([workflowDefinitions.id], {
    id: workflowVersions.id,
    definitionId: workflowDefinitions.id,
    snapshot: workflowVersions.snapshot,
    publishedAt: workflowVersions.publishedAt,
  }).from(workflowDefinitions)
    .innerJoin(workflowVersions, and(
      eq(workflowDefinitions.id, workflowVersions.definitionId),
      eq(workflowDefinitions.workspaceId, workflowVersions.workspaceId),
      lte(workflowVersions.version, workflowDefinitions.publishedVersion),
      lte(workflowVersions.publishedAt, occurrence),
    )).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.status, "PUBLISHED"),
    )).orderBy(workflowDefinitions.id, desc(workflowVersions.version)).limit(201);
  if (rows.length > 200) {
    throw new AppError("WORKFLOW_LIMIT_EXCEEDED", "Too many published workflows in this workspace.", 409);
  }
  if (!rows.length) return [];

  const definitionIds = rows.map(row => row.definitionId);
  const statuses = await db.selectDistinctOn([workflowStatusHistory.definitionId], {
    definitionId: workflowStatusHistory.definitionId,
    status: workflowStatusHistory.status,
  }).from(workflowStatusHistory).where(and(
    eq(workflowStatusHistory.workspaceId, workspaceId),
    inArray(workflowStatusHistory.definitionId, definitionIds),
    lte(workflowStatusHistory.occurredAt, occurrence),
  )).orderBy(workflowStatusHistory.definitionId, desc(workflowStatusHistory.occurredAt));

  const activeAtOccurrence = new Set(
    statuses.filter(row => row.status === "PUBLISHED").map(row => row.definitionId),
  );
  return rows.filter(row => activeAtOccurrence.has(row.definitionId)).map(row => ({
    ...row,
    snapshot: workflowDefinitionSchema.parse(row.snapshot),
  }));
}

// Execution retrieves the frozen version by workspace, not the editable draft.
export async function getWorkflowVersion(workspaceId: string, versionId: string) {
  const [row] = await db.select({
    version: workflowVersions,
    definitionStatus: workflowDefinitions.status,
    definitionName: workflowDefinitions.name,
  }).from(workflowVersions)
    .innerJoin(workflowDefinitions, and(
      eq(workflowDefinitions.workspaceId, workflowVersions.workspaceId),
      eq(workflowDefinitions.id, workflowVersions.definitionId),
    ))
    .where(and(
      eq(workflowVersions.workspaceId, workspaceId),
      eq(workflowVersions.id, versionId),
    )).limit(1);
  return row ? {
    ...row.version,
    definitionStatus: row.definitionStatus,
    definitionName: row.definitionName,
    snapshot: workflowDefinitionSchema.parse(row.version.snapshot),
  } : null;
}

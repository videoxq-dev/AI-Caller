import { and, desc, eq, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { automationEvents, automationEventType, workflowDefinitions, workflowVersions, workspaces } from "@/db/schema";
import { AppError } from "@/server/http/errors";

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
  actions: z.array(z.object({
    type: z.literal("NOTIFY_STAFF"),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(500),
  }).strict()).length(1),
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
    const [version] = await tx.insert(workflowVersions).values({
      workspaceId, definitionId, version: nextVersion, snapshot,
    }).returning();
    await tx.update(workflowDefinitions).set({
      status: "PUBLISHED", publishedVersion: nextVersion, updatedAt: new Date(),
    }).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.id, definitionId),
    ));
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
    const [updated] = await tx.update(workflowDefinitions).set({
      status, updatedAt: new Date(),
    }).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId),
      eq(workflowDefinitions.id, definitionId),
    )).returning();
    return updated;
  });
}

export async function listPublishedWorkflowVersions(workspaceId: string, eventId?: string) {
  // Compare timestamps in PostgreSQL: JS Date would discard PostgreSQL microseconds.
  const occurrence = eventId
    ? sql<Date>`(SELECT ${automationEvents.occurredAt} FROM ${automationEvents} WHERE ${automationEvents.id} = ${eventId} AND ${automationEvents.workspaceId} = ${workspaceId})`
    : sql<Date>`now()`;
  // Select one version per definition: the snapshot effective when the
  // business event was committed, even if a newer version was published later.
  // Events before the first publication are never replayed by a new workflow.
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
  return rows.map(row => ({
    ...row,
    snapshot: workflowDefinitionSchema.parse(row.snapshot),
  }));
}

// Execution retrieves the frozen version by workspace, not the editable draft.
export async function getWorkflowVersion(workspaceId: string, versionId: string) {
  const [row] = await db.select().from(workflowVersions).where(and(
    eq(workflowVersions.workspaceId, workspaceId),
    eq(workflowVersions.id, versionId),
  )).limit(1);
  return row ? { ...row, snapshot: workflowDefinitionSchema.parse(row.snapshot) } : null;
}

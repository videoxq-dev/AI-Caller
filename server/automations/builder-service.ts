import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  automationRuns,
  workflowDefinitions,
  workflowVersions,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { validateWorkflowActionsForPublication } from "./action-registry";
import {
  actionLabel,
  builderCatalog,
  conditionLabel,
  operatorLabel,
  triggerCatalogEntry,
} from "./builder-catalog";
import {
  matchesWorkflow,
  publishedWorkflowDefinitionSchema,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from "./workflows";

export function parseBuilderWorkflowId(id: string) {
  return parseInput(z.string().uuid(), id);
}

export type BuilderWorkflowStatus = "DRAFT" | "ACTIVE" | "PAUSED";

function toBuilderStatus(status: string): BuilderWorkflowStatus {
  if (status === "PUBLISHED") return "ACTIVE";
  if (status === "PAUSED") return "PAUSED";
  return "DRAFT";
}

function publishedAsDraft(snapshot: unknown): WorkflowDefinition | null {
  const parsed = publishedWorkflowDefinitionSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  return workflowDefinitionSchema.parse({
    ...parsed.data,
    actions: parsed.data.actions.map(action => {
      if (action.type === "SEND_CUSTOMER_SMS") {
        const { classifiedPurpose: _classifiedPurpose, ...draftAction } = action;
        return draftAction;
      }
      if (action.type === "SEND_CUSTOMER_WHATSAPP") {
        const { approvedCategory: _approvedCategory, ...draftAction } = action;
        return draftAction;
      }
      return action;
    }),
  });
}

function sameDefinition(left: WorkflowDefinition, right: WorkflowDefinition) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function workflowRunCounts(workspaceId: string, definitionIds: string[]) {
  if (!definitionIds.length) return new Map<string, number>();
  const rows = await db.select({
    definitionId: workflowVersions.definitionId,
    total: sql<number>`count(${automationRuns.id})::int`,
  }).from(workflowVersions)
    .leftJoin(automationRuns, and(
      eq(automationRuns.workspaceId, workflowVersions.workspaceId),
      eq(automationRuns.workflowVersionId, workflowVersions.id),
    ))
    .where(and(
      eq(workflowVersions.workspaceId, workspaceId),
      inArray(workflowVersions.definitionId, definitionIds),
    ))
    .groupBy(workflowVersions.definitionId);
  return new Map(rows.map(row => [row.definitionId, row.total]));
}

export async function listBuilderWorkflows(workspaceId: string, offset = 0, limit = 50) {
  if (!Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError("WORKFLOW_PAGE_INVALID", "Invalid automation page.", 400);
  }
  const definitions = await db.select().from(workflowDefinitions).where(and(
    eq(workflowDefinitions.workspaceId, workspaceId),
    ne(workflowDefinitions.status, "ARCHIVED"),
  )).orderBy(desc(workflowDefinitions.updatedAt), desc(workflowDefinitions.id))
    .offset(offset).limit(limit);
  if (!definitions.length) return [];

  const definitionIds = definitions.map(item => item.id);
  const [counts, publishedRows] = await Promise.all([
    workflowRunCounts(workspaceId, definitionIds),
    definitions.some(item => item.publishedVersion)
      ? db.select({
          definitionId: workflowVersions.definitionId,
          snapshot: workflowVersions.snapshot,
        }).from(workflowVersions)
          .innerJoin(workflowDefinitions, and(
            eq(workflowDefinitions.workspaceId, workflowVersions.workspaceId),
            eq(workflowDefinitions.id, workflowVersions.definitionId),
            eq(workflowDefinitions.publishedVersion, workflowVersions.version),
          ))
          .where(and(
            eq(workflowVersions.workspaceId, workspaceId),
            inArray(workflowDefinitions.id, definitionIds),
          ))
      : Promise.resolve([]),
  ]);
  const publishedByDefinition = new Map(
    publishedRows.map(row => [row.definitionId, row.snapshot]),
  );

  return definitions.map(definition => {
    const draft = workflowDefinitionSchema.parse(definition.draft);
    const published = publishedByDefinition.get(definition.id);
    const publishedDraft = published ? publishedAsDraft(published.snapshot) : null;
    return {
      id: definition.id,
      name: definition.name,
      status: toBuilderStatus(definition.status),
      trigger: draft.trigger,
      triggerLabel: triggerCatalogEntry(draft.trigger)?.label ?? "Automation trigger",
      actionLabels: draft.actions.map(action => actionLabel(action.type)),
      runCount: counts.get(definition.id) ?? 0,
      hasUnpublishedChanges: Boolean(
        definition.publishedVersion
        && publishedDraft
        && !sameDefinition(draft, publishedDraft)
      ),
      updatedAt: definition.updatedAt,
    };
  });
}

export async function getBuilderWorkflow(workspaceId: string, definitionId: string) {
  const [definition] = await db.select().from(workflowDefinitions).where(and(
    eq(workflowDefinitions.workspaceId, workspaceId),
    eq(workflowDefinitions.id, definitionId),
    ne(workflowDefinitions.status, "ARCHIVED"),
  )).limit(1);
  if (!definition) throw new AppError("WORKFLOW_NOT_FOUND", "Automation not found.", 404);

  const draft = workflowDefinitionSchema.parse(definition.draft);
  let hasUnpublishedChanges = false;
  if (definition.publishedVersion) {
    const [published] = await db.select({ snapshot: workflowVersions.snapshot })
      .from(workflowVersions).where(and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.definitionId, definitionId),
        eq(workflowVersions.version, definition.publishedVersion),
      )).limit(1);
    const publishedDraft = published ? publishedAsDraft(published.snapshot) : null;
    hasUnpublishedChanges = Boolean(publishedDraft && !sameDefinition(draft, publishedDraft));
  }

  return {
    id: definition.id,
    name: definition.name,
    status: toBuilderStatus(definition.status),
    draft,
    hasUnpublishedChanges,
    updatedAt: definition.updatedAt,
  };
}

const dryRunSampleSchema = z.object({
  qualificationScore: z.number().finite().min(0).max(100).optional(),
  channel: z.enum(["PHONE", "SMS", "WHATSAPP", "WEBCHAT"]).optional(),
}).strict();

const dryRunInputSchema = z.object({
  draft: workflowDefinitionSchema.optional(),
  sample: dryRunSampleSchema.default({}),
}).strict();

function conditionOutcome(
  condition: WorkflowDefinition["conditions"][number],
  payload: Record<string, unknown>,
) {
  const actual = payload[condition.field];
  let matched = false;
  if (typeof actual === typeof condition.value) {
    if (condition.operator === "EQ") matched = actual === condition.value;
    else if (typeof actual === "number" && typeof condition.value === "number") {
      matched = condition.operator === "GTE"
        ? actual >= condition.value
        : actual <= condition.value;
    }
  }
  const value = condition.field === "channel"
    ? builderCatalog.conditions.channel.options.find(item => item.id === actual)?.label ?? String(actual ?? "")
    : actual;
  const expected = condition.field === "channel"
    ? builderCatalog.conditions.channel.options.find(item => item.id === condition.value)?.label
      ?? String(condition.value)
    : condition.value;
  return {
    field: conditionLabel(condition.field),
    operator: operatorLabel(condition.operator),
    actual: value,
    expected,
    matched,
  };
}

function actionPreview(action: WorkflowDefinition["actions"][number]) {
  if (action.type === "ASSIGN_LEAD") return { type: action.type, label: "Assign lead", userId: action.userId };
  if (action.type === "NOTIFY_STAFF") {
    return { type: action.type, label: "Notify", userId: action.userId, title: action.title };
  }
  return { type: action.type, label: "Send customer an SMS" };
}

export async function testBuilderWorkflow(
  workspaceId: string,
  definitionId: string,
  input: unknown,
) {
  const workflow = await getBuilderWorkflow(workspaceId, definitionId);
  const parsed = parseInput(dryRunInputSchema, input);
  const draft = parsed.draft ?? workflow.draft;
  const sample = parsed.sample;
  await validateWorkflowActionsForPublication({
    workspaceId,
    trigger: draft.trigger,
    actions: draft.actions,
  });
  const payload: Record<string, unknown> = {};

  for (const condition of draft.conditions) {
    if (condition.field === "qualificationScore") {
      if (sample.qualificationScore === undefined) {
        throw new AppError("WORKFLOW_TEST_INPUT_REQUIRED", "Enter a qualification score.", 400);
      }
      payload.qualificationScore = sample.qualificationScore;
    }
    if (condition.field === "channel") {
      if (!sample.channel) throw new AppError("WORKFLOW_TEST_INPUT_REQUIRED", "Choose a channel.", 400);
      payload.channel = sample.channel;
    }
  }

  const event = { type: draft.trigger, payload } as const;
  const conditionResults = draft.conditions.map(condition => conditionOutcome(condition, payload));
  return {
    matches: matchesWorkflow(draft, event),
    conditions: conditionResults,
    actions: draft.actions.map(actionPreview),
  };
}

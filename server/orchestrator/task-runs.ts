import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentTaskRuns, agentTaskSteps, messages } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import {
  agentActionRegistry,
  type RegisteredAgentActionName,
} from "./action-registry";
import {
  executeOrchestratorTools,
  type OrchestratorEnvelope,
  type OrchestratorToolResult,
} from "./tools";

type ActionExecutor = (
  workspaceId: string,
  conversationId: string,
  contactId: string,
  envelope: OrchestratorEnvelope,
) => Promise<OrchestratorToolResult>;

export type AgentTaskRunStatus =
  | "RUNNING"
  | "WAITING_CUSTOMER"
  | "WAITING_CONFIRMATION"
  | "COMPLETED"
  | "FAILED";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function inputHash(value: Record<string, unknown>) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function taskActionForEnvelope(envelope: OrchestratorEnvelope): RegisteredAgentActionName {
  if (envelope.action.type !== "NONE") return envelope.action.type;
  if (envelope.contact) return "UPDATE_CONTACT";
  if (envelope.lead?.status === "QUALIFIED") return "QUALIFY_LEAD";
  if (envelope.lead) return "UPDATE_LEAD";
  return "ANSWER_INQUIRY";
}

function bookingExecutionProtected(envelope: OrchestratorEnvelope) {
  return envelope.action.type === "CHECK_AVAILABILITY"
    || envelope.action.type === "BOOK_APPOINTMENT";
}

function taskStatusForResult(result: OrchestratorToolResult): AgentTaskRunStatus {
  if (result.kind === "pending_action") return "WAITING_CONFIRMATION";
  if (result.kind === "availability") return "WAITING_CUSTOMER";
  if (result.kind === "qualification"
    && result.data.qualified !== true
    && Array.isArray(result.data.missingRequired)
    && result.data.missingRequired.length > 0) {
    return "WAITING_CUSTOMER";
  }
  return "COMPLETED";
}

async function latestCustomerMessageId(workspaceId: string, conversationId: string) {
  const [message] = await db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.senderType, "CUSTOMER"),
  )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  return message?.id ?? null;
}

async function ensureTaskRun(
  workspaceId: string,
  conversationId: string,
  contactId: string,
) {
  const sourceMessageId = await latestCustomerMessageId(workspaceId, conversationId);
  if (sourceMessageId) {
    const [existing] = await db.select().from(agentTaskRuns).where(and(
      eq(agentTaskRuns.workspaceId, workspaceId),
      eq(agentTaskRuns.conversationId, conversationId),
      eq(agentTaskRuns.sourceMessageId, sourceMessageId),
    )).limit(1);
    if (existing) {
      const [resumed] = await db.update(agentTaskRuns).set({
        status: "RUNNING",
        terminationReason: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(eq(agentTaskRuns.id, existing.id)).returning();
      return resumed;
    }
  }

  const [created] = await db.insert(agentTaskRuns).values({
    workspaceId,
    conversationId,
    contactId,
    sourceMessageId,
  }).returning();
  return created;
}

async function beginTaskStep(
  run: typeof agentTaskRuns.$inferSelect,
  action: RegisteredAgentActionName,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${run.id}))`);
    const [latest] = await tx.select({ sequence: agentTaskSteps.sequence })
      .from(agentTaskSteps)
      .where(eq(agentTaskSteps.runId, run.id))
      .orderBy(desc(agentTaskSteps.sequence))
      .limit(1);
    const definition = agentActionRegistry[action];
    const [step] = await tx.insert(agentTaskSteps).values({
      workspaceId: run.workspaceId,
      runId: run.id,
      sequence: (latest?.sequence ?? 0) + 1,
      action,
      risk: definition.risk,
      input,
      inputHash: inputHash(input),
    }).returning();
    return step;
  });
}

async function completeTaskStep(
  stepId: string,
  result: OrchestratorToolResult,
) {
  await db.update(agentTaskSteps).set({
    status: "COMPLETED",
    result: { kind: result.kind, data: result.data },
    completedAt: new Date(),
    errorCode: null,
  }).where(eq(agentTaskSteps.id, stepId));
}

async function failTaskStep(stepId: string, error: unknown) {
  await db.update(agentTaskSteps).set({
    status: "FAILED",
    errorCode: error instanceof AppError
      ? error.code.slice(0, 200)
      : "UNEXPECTED_ACTION_FAILURE",
    completedAt: new Date(),
  }).where(eq(agentTaskSteps.id, stepId));
}

async function finishTaskRun(
  runId: string,
  status: AgentTaskRunStatus,
  terminationReason: string | null = null,
) {
  await db.update(agentTaskRuns).set({
    status,
    terminationReason,
    completedAt: status === "COMPLETED" || status === "FAILED" ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(agentTaskRuns.id, runId));
}

export function createTrackedActionExecutor(executor: ActionExecutor): ActionExecutor {
  return async (workspaceId, conversationId, contactId, envelope) => {
    // Phase 2 must not become a second booking engine. Until the task runner
    // consumes booking receipts directly, availability and booking continue
    // through the already-proven booking path without an added persistence
    // dependency at this boundary.
    if (bookingExecutionProtected(envelope)) {
      return executor(workspaceId, conversationId, contactId, envelope);
    }

    const run = await ensureTaskRun(workspaceId, conversationId, contactId);
    const action = taskActionForEnvelope(envelope);
    const trackedInput: Record<string, unknown> = {
      action: envelope.action,
      ...(envelope.contact ? { contact: envelope.contact } : {}),
      ...(envelope.lead ? { lead: envelope.lead } : {}),
      ...(envelope.unresolved ? { unresolved: envelope.unresolved } : {}),
    };
    const step = await beginTaskStep(run, action, trackedInput);

    try {
      const result = await executor(workspaceId, conversationId, contactId, envelope);
      await completeTaskStep(step.id, result);
      await finishTaskRun(run.id, taskStatusForResult(result));
      return result;
    } catch (error) {
      await failTaskStep(step.id, error);
      await finishTaskRun(
        run.id,
        "FAILED",
        error instanceof AppError ? error.code : "UNEXPECTED_ACTION_FAILURE",
      );
      throw error;
    }
  };
}

export const executeTrackedOrchestratorTools =
  createTrackedActionExecutor(executeOrchestratorTools);

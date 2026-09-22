import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentTaskRuns, agentTaskSteps, messages } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import {
  agentActionRegistry,
  type RegisteredAgentActionName,
} from "./action-registry";
import {
  executeValidatedOrchestratorTools,
  validateOrchestratorToolResultForAction,
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
  | "WAITING_SYSTEM"
  | "COMPLETED"
  | "FAILED";

type TaskIdentity = {
  taskKey?: string;
  sourceMessageId?: string | null;
  objective?: string | null;
  metadata?: Record<string, unknown>;
};

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

function hashInput(value: Record<string, unknown>) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function taskActionForEnvelope(envelope: OrchestratorEnvelope): RegisteredAgentActionName {
  if (envelope.action.type !== "NONE") return envelope.action.type;
  if (envelope.contact) return "UPDATE_CONTACT";
  // Lead metadata never performs qualification. Only the explicit
  // QUALIFY_LEAD action may evaluate configured criteria and promote status.
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
  if (result.kind === "sms" && result.data.sent !== true) return "FAILED";
  if (result.kind === "booking"
    && ["COMMITTING", "RECONCILING"].includes(String(result.data.status ?? result.data.state ?? ""))) {
    return "WAITING_SYSTEM";
  }
  if (result.kind === "booking"
    && String(result.data.status ?? result.data.state ?? "") === "FAILED") {
    return "FAILED";
  }
  if (result.kind === "qualification"
    && result.data.qualified !== true
    && Array.isArray(result.data.missingRequired)
    && result.data.missingRequired.length > 0) {
    return "WAITING_CUSTOMER";
  }
  return "COMPLETED";
}

function replayActionType(action: RegisteredAgentActionName): OrchestratorEnvelope["action"]["type"] {
  if (action === "ANSWER_INQUIRY" || action === "UPDATE_CONTACT" || action === "UPDATE_LEAD") {
    return "NONE";
  }
  return action;
}

function storedToolResult(
  action: RegisteredAgentActionName,
  value: unknown,
): OrchestratorToolResult | null {
  if (value == null) return null;
  return validateOrchestratorToolResultForAction(
    replayActionType(action),
    value,
  );
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
  identity: TaskIdentity = {},
  resume = true,
) {
  const sourceMessageId = identity.sourceMessageId === undefined
    ? await latestCustomerMessageId(workspaceId, conversationId)
    : identity.sourceMessageId;
  const taskKey = identity.taskKey
    ?? (sourceMessageId ? `turn:${sourceMessageId}` : `conversation:${conversationId}`);

  const loadExisting = async () => {
    const [row] = await db.select().from(agentTaskRuns).where(and(
      eq(agentTaskRuns.workspaceId, workspaceId),
      eq(agentTaskRuns.conversationId, conversationId),
      eq(agentTaskRuns.taskKey, taskKey),
    )).limit(1);
    return row ?? null;
  };

  let existing = await loadExisting();
  if (!existing) {
    const [created] = await db.insert(agentTaskRuns).values({
      workspaceId,
      conversationId,
      contactId,
      sourceMessageId,
      taskKey,
      objective: identity.objective ?? null,
      metadata: identity.metadata ?? {},
    }).onConflictDoNothing().returning();
    if (created) return created;
    existing = await loadExisting();
    if (!existing) {
      throw new AppError(
        "AGENT_TASK_RUN_CONFLICT",
        "The task state could not be established safely.",
        409,
      );
    }
  }

  if (!resume) return existing;
  const [resumed] = await db.update(agentTaskRuns).set({
    status: "RUNNING",
    terminationReason: null,
    completedAt: null,
    updatedAt: new Date(),
    ...(identity.objective !== undefined ? { objective: identity.objective } : {}),
    ...(identity.metadata ? { metadata: { ...existing.metadata, ...identity.metadata } } : {}),
  }).where(and(
    eq(agentTaskRuns.id, existing.id),
    eq(agentTaskRuns.workspaceId, workspaceId),
    eq(agentTaskRuns.conversationId, conversationId),
  )).returning();
  if (!resumed) {
    throw new AppError(
      "AGENT_TASK_RUN_NOT_FOUND",
      "The task state disappeared before execution.",
      409,
    );
  }
  return resumed;
}

export async function ensureConversationTurnTaskRun(
  workspaceId: string,
  conversationId: string,
  contactId: string,
) {
  const run = await ensureTaskRun(
    workspaceId,
    conversationId,
    contactId,
    {},
    false,
  );
  if (run.status !== "RUNNING") return run;
  const [step] = await db.select({ id: agentTaskSteps.id })
    .from(agentTaskSteps)
    .where(eq(agentTaskSteps.runId, run.id))
    .limit(1);
  if (step) return run;
  await finishTaskRun(run.id, "COMPLETED", "NO_SERVER_ACTION_YET");
  return { ...run, status: "COMPLETED", terminationReason: "NO_SERVER_ACTION_YET" };
}

async function beginTaskStep(
  run: typeof agentTaskRuns.$inferSelect,
  action: RegisteredAgentActionName,
  input: Record<string, unknown>,
  idempotencyKey?: string | null,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${run.id}))`);

    if (idempotencyKey) {
      const [existing] = await tx.select().from(agentTaskSteps).where(and(
        eq(agentTaskSteps.runId, run.id),
        eq(agentTaskSteps.idempotencyKey, idempotencyKey),
      )).limit(1);
      if (existing) return { step: existing, reused: true as const };
    }

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
      inputHash: hashInput(input),
      idempotencyKey: idempotencyKey ?? null,
    }).returning();
    return { step, reused: false as const };
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

export async function recordExternalTaskReceipt(input: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  taskKey: string;
  sourceMessageId?: string | null;
  objective?: string | null;
  action: "CHECK_AVAILABILITY" | "BOOK_APPOINTMENT";
  actionInput: Record<string, unknown>;
  result: OrchestratorToolResult;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const validatedResult = validateOrchestratorToolResultForAction(
      input.action,
      input.result,
    );
    const run = await ensureTaskRun(
      input.workspaceId,
      input.conversationId,
      input.contactId,
      {
        taskKey: input.taskKey,
        sourceMessageId: input.sourceMessageId,
        objective: input.objective,
        metadata: input.metadata,
      },
    );
    const started = await beginTaskStep(
      run,
      input.action,
      input.actionInput,
      input.idempotencyKey,
    );
    if (started.reused) {
      const saved = storedToolResult(input.action, started.step.result);
      if (started.step.status === "COMPLETED" && saved) {
        await finishTaskRun(run.id, taskStatusForResult(saved));
        return { run, step: started.step, result: saved, reused: true as const };
      }
      return { run, step: started.step, result: null, reused: true as const };
    }

    await completeTaskStep(started.step.id, validatedResult);
    await finishTaskRun(run.id, taskStatusForResult(validatedResult));
    return { run, step: started.step, result: validatedResult, reused: false as const };
  } catch (error) {
    // Booking and other protected domain engines must never fail because the
    // cross-channel task audit trail could not be written after the fact.
    logger.error(
      {
        err: error,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        taskKey: input.taskKey,
        action: input.action,
      },
      "Unable to persist external agent task receipt",
    );
    return null;
  }
}

export function createTrackedActionExecutor(executor: ActionExecutor): ActionExecutor {
  return async (workspaceId, conversationId, contactId, envelope) => {
    // Phase 2 must not become a second booking engine. Availability and booking
    // continue through the proven booking subsystem. Their authoritative
    // receipts are attached separately after the booking domain succeeds.
    if (bookingExecutionProtected(envelope)) {
      return executor(workspaceId, conversationId, contactId, envelope);
    }

    const action = taskActionForEnvelope(envelope);
    const trackedInput: Record<string, unknown> = {
      action: envelope.action,
      ...(envelope.contact ? { contact: envelope.contact } : {}),
      ...(envelope.lead ? { lead: envelope.lead } : {}),
      ...(envelope.unresolved ? { unresolved: envelope.unresolved } : {}),
    };
    const hash = hashInput(trackedInput);
    const run = await ensureTaskRun(workspaceId, conversationId, contactId);
    const started = await beginTaskStep(
      run,
      action,
      trackedInput,
      `orchestrator:${action}:${hash}`,
    );

    if (started.reused) {
      const saved = storedToolResult(action, started.step.result);
      if (started.step.status === "COMPLETED" && saved) {
        await finishTaskRun(run.id, taskStatusForResult(saved));
        return saved;
      }
      if (started.step.status === "FAILED") {
        throw new AppError(
          "AGENT_TASK_STEP_PREVIOUSLY_FAILED",
          "This action already failed for the current customer turn.",
          409,
        );
      }
      throw new AppError(
        "AGENT_TASK_STEP_IN_PROGRESS",
        "This action is already being processed for the current customer turn.",
        409,
      );
    }

    try {
      const result = await executor(workspaceId, conversationId, contactId, envelope);
      await completeTaskStep(started.step.id, result);
      await finishTaskRun(run.id, taskStatusForResult(result));
      return result;
    } catch (error) {
      await failTaskStep(started.step.id, error);
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
  createTrackedActionExecutor(executeValidatedOrchestratorTools);

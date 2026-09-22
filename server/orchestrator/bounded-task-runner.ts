import { createHash } from "node:crypto";
import type { OrchestratorEnvelope, OrchestratorToolResult } from "./tools";

export type BoundedTaskStopReason =
  | "COMPLETE"
  | "TERMINAL_RESULT"
  | "CYCLE"
  | "ACTION_BUDGET";

export type BoundedTaskStep = {
  envelope: OrchestratorEnvelope;
  result: OrchestratorToolResult;
};

export type BoundedTaskOutcome = {
  finalEnvelope: OrchestratorEnvelope;
  finalResult: OrchestratorToolResult;
  steps: BoundedTaskStep[];
  stopReason: BoundedTaskStopReason;
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

function executionFingerprint(envelope: OrchestratorEnvelope) {
  const work = {
    action: envelope.action,
    contact: envelope.contact ?? null,
    lead: envelope.lead ?? null,
  };
  return createHash("sha256").update(stableJson(work)).digest("hex");
}

export function envelopeHasServerWork(envelope: OrchestratorEnvelope) {
  return envelope.action.type !== "NONE"
    || Boolean(envelope.contact)
    || Boolean(envelope.lead);
}

export function resultAllowsSameTurnContinuation(result: OrchestratorToolResult) {
  return result.kind === "qualification" || result.kind === "contact";
}

export async function runBoundedTaskChain(input: {
  initialEnvelope: OrchestratorEnvelope;
  initialResult: OrchestratorToolResult;
  replan: (
    previousEnvelope: OrchestratorEnvelope,
    result: OrchestratorToolResult,
    actionCount: number,
  ) => Promise<OrchestratorEnvelope>;
  execute: (envelope: OrchestratorEnvelope) => Promise<OrchestratorToolResult>;
  maxActions?: number;
}): Promise<BoundedTaskOutcome> {
  const maxActions = Math.min(Math.max(input.maxActions ?? 3, 1), 5);
  const steps: BoundedTaskStep[] = [{
    envelope: input.initialEnvelope,
    result: input.initialResult,
  }];
  const fingerprints = new Set<string>([
    executionFingerprint(input.initialEnvelope),
  ]);

  let currentEnvelope = input.initialEnvelope;
  let currentResult = input.initialResult;

  while (resultAllowsSameTurnContinuation(currentResult)) {
    if (steps.length >= maxActions) {
      return {
        finalEnvelope: currentEnvelope,
        finalResult: currentResult,
        steps,
        stopReason: "ACTION_BUDGET",
      };
    }

    const next = await input.replan(currentEnvelope, currentResult, steps.length);
    if (!envelopeHasServerWork(next)) {
      return {
        finalEnvelope: next,
        finalResult: currentResult,
        steps,
        stopReason: "COMPLETE",
      };
    }

    const fingerprint = executionFingerprint(next);
    if (fingerprints.has(fingerprint)) {
      return {
        finalEnvelope: next,
        finalResult: currentResult,
        steps,
        stopReason: "CYCLE",
      };
    }
    fingerprints.add(fingerprint);

    const result = await input.execute(next);
    steps.push({ envelope: next, result });
    currentEnvelope = next;
    currentResult = result;

    if (!resultAllowsSameTurnContinuation(result)) {
      return {
        finalEnvelope: next,
        finalResult: result,
        steps,
        stopReason: "TERMINAL_RESULT",
      };
    }
  }

  return {
    finalEnvelope: currentEnvelope,
    finalResult: currentResult,
    steps,
    stopReason: "TERMINAL_RESULT",
  };
}

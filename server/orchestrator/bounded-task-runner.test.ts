import { describe, expect, it, vi } from "vitest";
import {
  envelopeHasServerWork,
  resultAllowsSameTurnContinuation,
  runBoundedTaskChain,
} from "./bounded-task-runner";

describe("bounded task runner", () => {
  it("continues from an authoritative qualification result into one dependent action", async () => {
    const execute = vi.fn(async () => ({
      kind: "availability" as const,
      data: { timezone: "UTC", slots: [] },
    }));
    const replan = vi.fn(async () => ({
      action: {
        type: "CHECK_AVAILABILITY" as const,
        startsAt: "2037-09-23T10:00:00Z",
        endsAt: "2037-09-23T12:00:00Z",
        timezone: "UTC",
      },
    }));

    const outcome = await runBoundedTaskChain({
      initialEnvelope: {
        action: {
          type: "QUALIFY_LEAD",
          answers: [{ criterionId: "budget", answer: "Yes" }],
        },
      },
      initialResult: {
        kind: "qualification",
        data: { qualified: true, missingRequired: [] },
      },
      replan,
      execute,
    });

    expect(outcome.stopReason).toBe("TERMINAL_RESULT");
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.finalResult.kind).toBe("availability");
    expect(replan).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("stops without another action when replanning returns a customer reply", async () => {
    const execute = vi.fn();
    const outcome = await runBoundedTaskChain({
      initialEnvelope: {
        action: {
          type: "QUALIFY_LEAD",
          answers: [{ criterionId: "budget", answer: "Yes" }],
        },
      },
      initialResult: {
        kind: "qualification",
        data: { qualified: true, missingRequired: [] },
      },
      replan: vi.fn(async () => ({
        reply: "Thanks, that is all I needed.",
        action: { type: "NONE" as const },
      })),
      execute,
    });

    expect(outcome.stopReason).toBe("COMPLETE");
    expect(outcome.finalEnvelope.reply).toContain("that is all");
    expect(execute).not.toHaveBeenCalled();
  });

  it("detects a repeated action before executing it twice", async () => {
    const initial = {
      action: {
        type: "QUALIFY_LEAD" as const,
        answers: [{ criterionId: "budget", answer: "Yes" }],
      },
    };
    const execute = vi.fn();
    const outcome = await runBoundedTaskChain({
      initialEnvelope: initial,
      initialResult: {
        kind: "qualification",
        data: { qualified: false, missingRequired: ["timeline"] },
      },
      replan: vi.fn(async () => initial),
      execute,
    });

    expect(outcome.stopReason).toBe("CYCLE");
    expect(outcome.steps).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("caps same-turn action execution even when every result asks to continue", async () => {
    let index = 0;
    const execute = vi.fn(async () => ({
      kind: "contact" as const,
      data: { updatedFields: ["name"] },
    }));
    const outcome = await runBoundedTaskChain({
      initialEnvelope: { contact: { name: "A" }, action: { type: "NONE" as const } },
      initialResult: { kind: "contact", data: { updatedFields: ["name"] } },
      replan: vi.fn(async () => ({
        contact: { name: `Customer ${++index}` },
        action: { type: "NONE" as const },
      })),
      execute,
      maxActions: 3,
    });

    expect(outcome.stopReason).toBe("ACTION_BUDGET");
    expect(outcome.steps).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("treats confirmation and calendar results as hard execution boundaries", () => {
    expect(resultAllowsSameTurnContinuation({ kind: "pending_action", data: {} })).toBe(false);
    expect(resultAllowsSameTurnContinuation({ kind: "availability", data: {} })).toBe(false);
    expect(resultAllowsSameTurnContinuation({ kind: "booking", data: {} })).toBe(false);
    expect(resultAllowsSameTurnContinuation({ kind: "sms", data: {} })).toBe(false);
    expect(resultAllowsSameTurnContinuation({ kind: "escalation", data: {} })).toBe(false);
    expect(envelopeHasServerWork({ reply: "Done", action: { type: "NONE" } })).toBe(false);
  });
});

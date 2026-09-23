import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/errors";
import {
  agentCapabilitiesSchema, assertAgentActionAllowed,
  capabilitiesFromBehaviorSettings, defaultAgentCapabilities,
} from "./capabilities";

describe("agent capability policy", () => {
  it("preserves existing agent permissions when policy is not configured", () => {
    expect(capabilitiesFromBehaviorSettings({ voice: {} })).toEqual(defaultAgentCapabilities);
  });

  it("fails closed on missing or unknown persisted capability keys", () => {
    expect(() => capabilitiesFromBehaviorSettings({ capabilities: { BOOK_APPOINTMENT: false } }))
      .toThrow(AppError);
    expect(() => capabilitiesFromBehaviorSettings({ capabilities: { ...defaultAgentCapabilities, EXTRA: true } }))
      .toThrow("administrator review");
  });

  it("preserves legacy appointment permissions when new management keys are absent", () => {
    const {
      RESCHEDULE_APPOINTMENT: _reschedule,
      CANCEL_APPOINTMENT: _cancel,
      ...legacy
    } = defaultAgentCapabilities;
    const oldPolicy = capabilitiesFromBehaviorSettings({ capabilities: legacy });
    expect(oldPolicy).toEqual(defaultAgentCapabilities);
    const disabled = capabilitiesFromBehaviorSettings({
      capabilities: { ...legacy, BOOK_APPOINTMENT: false },
    });
    expect(disabled.BOOK_APPOINTMENT).toBe(false);
    expect(disabled.RESCHEDULE_APPOINTMENT).toBe(false);
    expect(disabled.CANCEL_APPOINTMENT).toBe(false);
  });

  it("rejects disabled booking even when the planner supplies a well-formed action", () => {
    const policy = agentCapabilitiesSchema.parse({ ...defaultAgentCapabilities, BOOK_APPOINTMENT: false });
    try {
      assertAgentActionAllowed(policy, "BOOK_APPOINTMENT");
      throw new Error("Expected booking to be blocked.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "AGENT_ACTION_DISABLED", status: 403 });
    }
    expect(() => assertAgentActionAllowed(policy, "CHECK_AVAILABILITY")).not.toThrow();
  });
});

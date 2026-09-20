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

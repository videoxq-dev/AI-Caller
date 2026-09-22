import { describe, expect, it } from "vitest";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import {
  agentActionRegistry,
  capabilityForOrchestratorAction,
  isRealtimeBusinessToolName,
  realtimeBusinessToolAllowed,
} from "./action-registry";

describe("agent action registry", () => {
  it("classifies consequential actions without weakening booking confirmation", () => {
    expect(agentActionRegistry.BOOK_APPOINTMENT).toMatchObject({
      capability: "BOOK_APPOINTMENT",
      risk: "CONSEQUENTIAL",
      confirmation: "EXPLICIT_CUSTOMER",
    });
    expect(agentActionRegistry.SEND_SMS).toMatchObject({
      capability: "SEND_SMS",
      risk: "CONSEQUENTIAL",
      confirmation: "EXPLICIT_CUSTOMER",
    });
    expect(agentActionRegistry.CHECK_AVAILABILITY.risk).toBe("READ_ONLY");
  });

  it("maps every orchestrator action to its server capability", () => {
    expect(capabilityForOrchestratorAction("NONE")).toBeNull();
    expect(capabilityForOrchestratorAction("CHECK_AVAILABILITY")).toBe("CHECK_AVAILABILITY");
    expect(capabilityForOrchestratorAction("BOOK_APPOINTMENT")).toBe("BOOK_APPOINTMENT");
    expect(capabilityForOrchestratorAction("ESCALATE")).toBe("ESCALATE");
  });

  it("rejects inherited or unknown Realtime tool names at the registry boundary", () => {
    expect(isRealtimeBusinessToolName("toString")).toBe(false);
    expect(isRealtimeBusinessToolName("__proto__")).toBe(false);
    expect(isRealtimeBusinessToolName("not_a_business_tool")).toBe(false);
    expect(isRealtimeBusinessToolName("book_appointment")).toBe(true);
  });

  it("uses the same capability policy for realtime tool exposure", () => {
    const disabled = {
      ...defaultAgentCapabilities,
      CHECK_AVAILABILITY: false,
      BOOK_APPOINTMENT: false,
      ESCALATE: false,
    };
    expect(realtimeBusinessToolAllowed("capture_booking_details", disabled)).toBe(false);
    expect(realtimeBusinessToolAllowed("check_availability", disabled)).toBe(false);
    expect(realtimeBusinessToolAllowed("book_appointment", disabled)).toBe(false);
    expect(realtimeBusinessToolAllowed("escalate_to_staff", disabled)).toBe(false);
    expect(realtimeBusinessToolAllowed("qualify_lead", disabled)).toBe(true);

    const availabilityOnly = {
      ...disabled,
      CHECK_AVAILABILITY: true,
    };
    expect(realtimeBusinessToolAllowed("capture_booking_details", availabilityOnly)).toBe(true);
    expect(realtimeBusinessToolAllowed("check_availability", availabilityOnly)).toBe(true);
    expect(realtimeBusinessToolAllowed("book_appointment", availabilityOnly)).toBe(false);
  });
});

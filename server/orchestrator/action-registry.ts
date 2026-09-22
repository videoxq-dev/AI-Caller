import type { AgentCapabilities, AgentCapability } from "@/server/agent/capabilities";

export type AgentActionRisk = "READ_ONLY" | "MUTATING" | "CONSEQUENTIAL";
export type AgentActionConfirmation = "NONE" | "EXPLICIT_CUSTOMER";

export type RegisteredAgentAction = {
  capability: AgentCapability;
  risk: AgentActionRisk;
  confirmation: AgentActionConfirmation;
  description: string;
};

export const agentActionRegistry = {
  ANSWER_INQUIRY: {
    capability: "ANSWER_INQUIRY",
    risk: "READ_ONLY",
    confirmation: "NONE",
    description: "Answer a customer using approved workspace context.",
  },
  UPDATE_CONTACT: {
    capability: "UPDATE_CONTACT",
    risk: "MUTATING",
    confirmation: "NONE",
    description: "Persist contact details explicitly provided by the customer.",
  },
  UPDATE_LEAD: {
    capability: "UPDATE_LEAD",
    risk: "MUTATING",
    confirmation: "NONE",
    description: "Persist supported lead intent and metadata.",
  },
  QUALIFY_LEAD: {
    capability: "QUALIFY_LEAD",
    risk: "MUTATING",
    confirmation: "NONE",
    description: "Persist qualification answers and let the server evaluate qualification.",
  },
  CHECK_AVAILABILITY: {
    capability: "CHECK_AVAILABILITY",
    risk: "READ_ONLY",
    confirmation: "NONE",
    description: "Read authoritative calendar availability.",
  },
  BOOK_APPOINTMENT: {
    capability: "BOOK_APPOINTMENT",
    risk: "CONSEQUENTIAL",
    confirmation: "EXPLICIT_CUSTOMER",
    description: "Commit a customer-approved appointment through the durable booking subsystem.",
  },
  RECORD_SMS_CONSENT: {
    capability: "RECORD_SMS_CONSENT",
    risk: "MUTATING",
    confirmation: "NONE",
    description: "Persist evidenced SMS consent or revocation.",
  },
  SEND_SMS: {
    capability: "SEND_SMS",
    risk: "CONSEQUENTIAL",
    confirmation: "EXPLICIT_CUSTOMER",
    description: "Send an outbound SMS through the compliance-gated messaging subsystem.",
  },
  ESCALATE: {
    capability: "ESCALATE",
    risk: "MUTATING",
    confirmation: "NONE",
    description: "Create issue-scoped staff follow-up without transferring the whole conversation.",
  },
} as const satisfies Record<AgentCapability, RegisteredAgentAction>;

export type RegisteredAgentActionName = keyof typeof agentActionRegistry;

export type OrchestratorActionType =
  | "NONE"
  | "RECORD_SMS_CONSENT"
  | "SEND_SMS"
  | "CHECK_AVAILABILITY"
  | "BOOK_APPOINTMENT"
  | "QUALIFY_LEAD"
  | "ESCALATE";

const realtimeToolCapabilityRules = {
  capture_booking_details: ["CHECK_AVAILABILITY", "BOOK_APPOINTMENT"],
  check_availability: ["CHECK_AVAILABILITY"],
  book_appointment: ["BOOK_APPOINTMENT"],
  escalate_to_staff: ["ESCALATE"],
  qualify_lead: ["QUALIFY_LEAD"],
} as const satisfies Record<string, readonly AgentCapability[]>;

export type RealtimeBusinessToolName = keyof typeof realtimeToolCapabilityRules;

export function isRealtimeBusinessToolName(name: string): name is RealtimeBusinessToolName {
  return Object.prototype.hasOwnProperty.call(realtimeToolCapabilityRules, name);
}

export function registeredAgentAction(name: RegisteredAgentActionName) {
  return agentActionRegistry[name];
}

export function capabilityForOrchestratorAction(type: OrchestratorActionType): AgentCapability | null {
  return type === "NONE" ? null : agentActionRegistry[type].capability;
}

export function realtimeBusinessToolAllowed(
  name: RealtimeBusinessToolName,
  policy: AgentCapabilities,
) {
  return realtimeToolCapabilityRules[name].some((capability) => policy[capability]);
}

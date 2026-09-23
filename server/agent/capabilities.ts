import { z } from "zod";
import { AppError } from "@/server/http/errors";

// Keys are authoritative backend operations, not prompts or user-created tools.
export const agentCapabilityCatalog = [
  { key: "ANSWER_INQUIRY", label: "Answer inquiries", description: "Answer customer questions using approved business knowledge." },
  { key: "UPDATE_CONTACT", label: "Update contacts", description: "Save customer details explicitly provided in a conversation." },
  { key: "UPDATE_LEAD", label: "Update leads", description: "Record supported lead details and intent." },
  { key: "QUALIFY_LEAD", label: "Qualify leads", description: "Record qualification answers; the server evaluates completion." },
  { key: "CHECK_AVAILABILITY", label: "Check availability", description: "Retrieve actual calendar availability." },
  { key: "BOOK_APPOINTMENT", label: "Book appointments", description: "Book a customer-selected appointment through the calendar service." },
  { key: "RESCHEDULE_APPOINTMENT", label: "Reschedule appointments", description: "Change a verified existing appointment only after customer confirmation." },
  { key: "CANCEL_APPOINTMENT", label: "Cancel appointments", description: "Cancel a verified existing appointment only after customer confirmation." },
  { key: "RECORD_SMS_CONSENT", label: "Record SMS consent", description: "Record evidenced consent; STOP remains effective independently." },
  { key: "SEND_SMS", label: "Send SMS", description: "Request SMS through the single-sender compliance gate." },
  { key: "ESCALATE", label: "Escalate to human", description: "Hand an active conversation to workspace staff." },
] as const;

export type AgentCapability = (typeof agentCapabilityCatalog)[number]["key"];
export const agentCapabilitiesSchema = z.object({
  ANSWER_INQUIRY: z.boolean(),
  UPDATE_CONTACT: z.boolean(),
  UPDATE_LEAD: z.boolean(),
  QUALIFY_LEAD: z.boolean(),
  CHECK_AVAILABILITY: z.boolean(),
  BOOK_APPOINTMENT: z.boolean(),
  RESCHEDULE_APPOINTMENT: z.boolean(),
  CANCEL_APPOINTMENT: z.boolean(),
  RECORD_SMS_CONSENT: z.boolean(),
  SEND_SMS: z.boolean(),
  ESCALATE: z.boolean(),
}).strict();

export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
export const defaultAgentCapabilities: Readonly<AgentCapabilities> = Object.freeze(
  Object.fromEntries(agentCapabilityCatalog.map(({ key }) => [key, true])) as AgentCapabilities,
);

export function capabilitiesFromBehaviorSettings(behavior: Record<string, unknown> | null | undefined): AgentCapabilities {
  // Existing customer records have no capabilities field; preserve their prior tool access.
  if (!behavior || !Object.prototype.hasOwnProperty.call(behavior, "capabilities")) {
    return { ...defaultAgentCapabilities };
  }
  // Two appointment-management permissions were added after initial rollout.
  // Preserve every old permission bit, including explicitly disabled booking;
  // default only these two newly introduced keys for legacy stored records.
  const stored = behavior.capabilities;
  const extended = stored && typeof stored === "object" && !Array.isArray(stored)
    ? {
        RESCHEDULE_APPOINTMENT: (stored as Record<string, unknown>).BOOK_APPOINTMENT,
        CANCEL_APPOINTMENT: (stored as Record<string, unknown>).BOOK_APPOINTMENT,
        ...stored,
      }
    : stored;
  const parsed = agentCapabilitiesSchema.safeParse(extended);
  // A corrupted/unknown stored policy must not silently re-enable tools.
  if (!parsed.success) throw new AppError("AGENT_POLICY_INVALID", "The agent capability policy needs administrator review.", 409);
  return parsed.data;
}

export function assertAgentActionAllowed(policy: AgentCapabilities, action: AgentCapability) {
  if (!policy[action]) {
    throw new AppError("AGENT_ACTION_DISABLED", `The agent is not permitted to perform ${action}.`, 403);
  }
}

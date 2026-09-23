import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { automationEventType, memberships } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export const MAX_WORKFLOW_ACTIONS = 5;

const staffUserId = z.string().trim().min(1).max(255);
const title = z.string().trim().min(1).max(120);
const staffMessage = z.string().trim().min(1).max(500);
const customerMessage = z.string().trim().min(1).max(2000);

export const notifyStaffActionSchema = z.object({
  type: z.literal("NOTIFY_STAFF"),
  userId: staffUserId.nullable().default(null),
  title,
  message: staffMessage,
}).strict();

export const assignLeadActionSchema = z.object({
  type: z.literal("ASSIGN_LEAD"),
  userId: staffUserId,
}).strict();

export const sendCustomerSmsActionSchema = z.object({
  type: z.literal("SEND_CUSTOMER_SMS"),
  message: customerMessage,
}).strict();

export const workflowActionSchema = z.discriminatedUnion("type", [
  notifyStaffActionSchema,
  assignLeadActionSchema,
  sendCustomerSmsActionSchema,
]);

export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export type WorkflowActionType = WorkflowAction["type"];
export type AutomationEventType = typeof automationEventType.enumValues[number];

const appointmentTriggers = new Set<AutomationEventType>([
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
]);

const smsTriggers = new Set<AutomationEventType>([
  "INQUIRY_RECEIVED",
  "LEAD_QUALIFIED",
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "CONVERSATION_ESCALATED",
]);

export function actionAllowedForTrigger(trigger: AutomationEventType, action: WorkflowAction) {
  if (action.type === "NOTIFY_STAFF") return true;
  if (action.type === "ASSIGN_LEAD") return trigger === "LEAD_QUALIFIED";
  if (action.type === "SEND_CUSTOMER_SMS") return smsTriggers.has(trigger);
  return false;
}

const commonVariables = new Set(["name", "business_name"]);
const appointmentVariables = new Set(["service", "appointment_date", "appointment_time"]);

export function templateVariables(template: string) {
  const variables = new Set<string>();
  for (const match of template.matchAll(/{{([a-z_]+)}}/g)) variables.add(match[1]);
  return [...variables];
}

function assertSupportedTemplateVariables(trigger: AutomationEventType, template: string) {
  const allowed = new Set(commonVariables);
  if (appointmentTriggers.has(trigger)) {
    for (const variable of appointmentVariables) allowed.add(variable);
  }
  for (const variable of templateVariables(template)) {
    if (!allowed.has(variable)) {
      throw new AppError(
        "WORKFLOW_TEMPLATE_VARIABLE_UNSUPPORTED",
        `{{${variable}}} is not available for ${trigger} workflows.`,
        400,
      );
    }
  }
  // Reject malformed handlebars-like placeholders rather than silently sending them.
  const stripped = template.replace(/{{([a-z_]+)}}/g, "");
  if (stripped.includes("{{") || stripped.includes("}}")) {
    throw new AppError(
      "WORKFLOW_TEMPLATE_INVALID",
      "Workflow message contains an invalid template placeholder.",
      400,
    );
  }
}

export async function validateWorkflowActionsForPublication(input: {
  workspaceId: string;
  trigger: AutomationEventType;
  actions: WorkflowAction[];
}) {
  if (input.actions.length < 1 || input.actions.length > MAX_WORKFLOW_ACTIONS) {
    throw new AppError(
      "WORKFLOW_ACTION_LIMIT",
      `A workflow must contain between 1 and ${MAX_WORKFLOW_ACTIONS} actions.`,
      400,
    );
  }

  const staffIds = new Set<string>();
  for (const action of input.actions) {
    if (!actionAllowedForTrigger(input.trigger, action)) {
      throw new AppError(
        "WORKFLOW_ACTION_TRIGGER_INVALID",
        `${action.type} cannot run for ${input.trigger} events.`,
        400,
      );
    }
    if (action.type === "SEND_CUSTOMER_SMS") {
      assertSupportedTemplateVariables(input.trigger, action.message);
    }
    if (action.type === "ASSIGN_LEAD") staffIds.add(action.userId);
    if (action.type === "NOTIFY_STAFF" && action.userId) staffIds.add(action.userId);
  }

  if (!staffIds.size) return;

  const rows = await db.select({ userId: memberships.userId }).from(memberships).where(and(
    eq(memberships.workspaceId, input.workspaceId),
    inArray(memberships.userId, [...staffIds]),
  ));
  const valid = new Set(rows.map(row => row.userId));
  const invalid = [...staffIds].filter(id => !valid.has(id));
  if (invalid.length) {
    throw new AppError(
      "WORKFLOW_STAFF_INVALID",
      "Every configured staff member must be a current member of this workspace.",
      400,
    );
  }
}

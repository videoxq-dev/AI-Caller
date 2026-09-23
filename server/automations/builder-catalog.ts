import type { WorkflowDefinition } from "./workflows";

export type BuilderStarterKey =
  | "HIGH_VALUE_LEAD_ALERT"
  | "NEW_APPOINTMENT_ALERT"
  | "CUSTOMER_BOOKING_CONFIRMATION"
  | "BLANK";

export const builderCatalog = {
  triggers: [
    {
      id: "INQUIRY_RECEIVED",
      label: "New inquiry received",
      conditions: ["channel"],
      actions: ["NOTIFY_STAFF", "SEND_CUSTOMER_SMS"],
      variables: ["name", "business_name"],
    },
    {
      id: "LEAD_QUALIFIED",
      label: "Lead becomes qualified",
      conditions: ["qualificationScore"],
      actions: ["ASSIGN_LEAD", "NOTIFY_STAFF", "SEND_CUSTOMER_SMS"],
      variables: ["name", "business_name"],
    },
    {
      id: "APPOINTMENT_CONFIRMED",
      label: "Appointment is booked",
      conditions: [],
      actions: ["NOTIFY_STAFF", "SEND_CUSTOMER_SMS"],
      variables: ["name", "business_name", "service", "appointment_date", "appointment_time"],
    },
    {
      id: "APPOINTMENT_RESCHEDULED",
      label: "Appointment is rescheduled",
      conditions: [],
      actions: ["NOTIFY_STAFF", "SEND_CUSTOMER_SMS"],
      variables: ["name", "business_name", "service", "appointment_date", "appointment_time"],
    },
    {
      id: "APPOINTMENT_CANCELLED",
      label: "Appointment is cancelled",
      conditions: [],
      actions: ["NOTIFY_STAFF", "SEND_CUSTOMER_SMS"],
      variables: ["name", "business_name", "service", "appointment_date", "appointment_time"],
    },
    {
      id: "CONVERSATION_ESCALATED",
      label: "Conversation needs human help",
      conditions: [],
      actions: ["NOTIFY_STAFF", "SEND_CUSTOMER_SMS"],
      variables: ["name", "business_name"],
    },
  ],
  conditions: {
    qualificationScore: {
      label: "Qualification score",
      kind: "number",
      min: 0,
      max: 100,
      operators: [
        { id: "EQ", label: "is" },
        { id: "GTE", label: "is at least" },
        { id: "LTE", label: "is at most" },
      ],
    },
    channel: {
      label: "Customer contacted you through",
      kind: "select",
      operators: [{ id: "EQ", label: "is" }],
      options: [
        { id: "PHONE", label: "Phone" },
        { id: "SMS", label: "SMS" },
        { id: "WHATSAPP", label: "WhatsApp" },
        { id: "WEBCHAT", label: "Web chat" },
      ],
    },
  },
  actions: [
    { id: "ASSIGN_LEAD", label: "Assign lead to" },
    { id: "NOTIFY_STAFF", label: "Notify" },
    { id: "SEND_CUSTOMER_SMS", label: "Send customer an SMS" },
  ],
  variables: [
    { id: "name", label: "Customer name" },
    { id: "business_name", label: "Business name" },
    { id: "service", label: "Service" },
    { id: "appointment_date", label: "Appointment date" },
    { id: "appointment_time", label: "Appointment time" },
  ],
  maxActions: 5,
} as const;

const starters: Record<BuilderStarterKey, { name: string; definition: WorkflowDefinition }> = {
  HIGH_VALUE_LEAD_ALERT: {
    name: "High-value lead alert",
    definition: {
      trigger: "LEAD_QUALIFIED",
      match: "ALL",
      conditions: [{ field: "qualificationScore", operator: "GTE", value: 80 }],
      actions: [{
        type: "NOTIFY_STAFF",
        userId: null,
        title: "High-value lead",
        message: "A high-value lead is ready for follow-up.",
      }],
    },
  },
  NEW_APPOINTMENT_ALERT: {
    name: "New appointment alert",
    definition: {
      trigger: "APPOINTMENT_CONFIRMED",
      match: "ALL",
      conditions: [],
      actions: [{
        type: "NOTIFY_STAFF",
        userId: null,
        title: "New appointment",
        message: "A new appointment has been booked.",
      }],
    },
  },
  CUSTOMER_BOOKING_CONFIRMATION: {
    name: "Customer booking confirmation",
    definition: {
      trigger: "APPOINTMENT_CONFIRMED",
      match: "ALL",
      conditions: [],
      actions: [{
        type: "SEND_CUSTOMER_SMS",
        message: "Hi {{name}}, your {{service}} appointment is booked for {{appointment_date}} at {{appointment_time}}.",
      }],
    },
  },
  BLANK: {
    name: "Untitled automation",
    definition: {
      trigger: "LEAD_QUALIFIED",
      match: "ALL",
      conditions: [],
      actions: [{
        type: "NOTIFY_STAFF",
        userId: null,
        title: "New qualified lead",
        message: "A lead is ready for follow-up.",
      }],
    },
  },
};

export function builderStarter(key: BuilderStarterKey) {
  return structuredClone(starters[key]);
}

export function triggerCatalogEntry(trigger: string) {
  return builderCatalog.triggers.find(item => item.id === trigger) ?? null;
}

export function conditionLabel(field: string) {
  if (field === "qualificationScore") return builderCatalog.conditions.qualificationScore.label;
  if (field === "channel") return builderCatalog.conditions.channel.label;
  return field;
}

export function operatorLabel(operator: string) {
  if (operator === "EQ") return "is";
  if (operator === "GTE") return "is at least";
  if (operator === "LTE") return "is at most";
  return operator;
}

export function actionLabel(type: string) {
  return builderCatalog.actions.find(item => item.id === type)?.label ?? type;
}

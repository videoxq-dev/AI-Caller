import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./core";

export const automationKey = pgEnum("automation_key", [
  "MISSED_INQUIRY_RECOVERY",
  "QUALIFIED_LEAD_ASSIGNMENT",
  "APPOINTMENT_CONFIRMATION",
  "APPOINTMENT_REMINDER",
  "HUMAN_ESCALATION",
]);

export const automationEventType = pgEnum("automation_event_type", [
  "INQUIRY_RECEIVED",
  "LEAD_QUALIFIED",
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "CONVERSATION_ESCALATED",
]);

export const automationRunStatus = pgEnum("automation_run_status", [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "SKIPPED",
  "FAILED",
]);

export const automationDeliveryStatus = pgEnum("automation_delivery_status", [
  "PENDING",
  "SENT",
  "SKIPPED",
  "FAILED",
  "UNKNOWN",
]);

export const automationSettings = pgTable(
  "automation_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    key: automationKey("key").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("automation_settings_workspace_key_uq").on(table.workspaceId, table.key)],
);

export const automationEvents = pgTable(
  "automation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    type: automationEventType("type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    occurrenceKey: text("occurrence_key").default("default").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("automation_events_workspace_occurrence_uq").on(
      table.workspaceId,
      table.type,
      table.aggregateType,
      table.aggregateId,
      table.occurrenceKey,
    ),
    index("automation_events_dispatch_idx").on(table.dispatchedAt, table.createdAt),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull().references(() => automationEvents.id, { onDelete: "cascade" }),
    key: automationKey("key").notNull(),
    occurrenceKey: text("occurrence_key").default("default").notNull(),
    status: automationRunStatus("status").default("PENDING").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("automation_runs_event_key_occurrence_uq").on(table.eventId, table.key, table.occurrenceKey),
    index("automation_runs_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("automation_runs_scheduled_idx").on(table.status, table.scheduledFor),
  ],
);

export const automationDeliveries = pgTable(
  "automation_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    status: automationDeliveryStatus("status").default("PENDING").notNull(),
    messageId: uuid("message_id"),
    providerExternalId: text("provider_external_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("automation_deliveries_run_channel_recipient_uq").on(table.runId, table.channel, table.recipient),
    index("automation_deliveries_workspace_created_idx").on(table.workspaceId, table.createdAt),
  ],
);


import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  integer,
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
  "CANCELLED",
]);

export const automationDeliveryStatus = pgEnum("automation_delivery_status", [
  "PENDING",
  "SENT",
  "SKIPPED",
  "FAILED",
  "UNKNOWN",
]);

export const workflowActionRunStatus = pgEnum("workflow_action_run_status", [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "SKIPPED",
  "FAILED",
  "UNKNOWN",
  "CANCELLED",
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

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").$type<"DRAFT" | "PUBLISHED" | "PAUSED" | "ARCHIVED">().default("DRAFT").notNull(),
    draft: jsonb("draft").$type<Record<string, unknown>>().default({}).notNull(),
    publishedVersion: integer("published_version"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workflow_definitions_id_workspace_uq").on(table.id, table.workspaceId),
    index("workflow_definitions_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id").notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "workflow_versions_definition_workspace_fk",
      columns: [table.definitionId, table.workspaceId],
      foreignColumns: [workflowDefinitions.id, workflowDefinitions.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("workflow_versions_definition_version_uq").on(table.definitionId, table.version),
    uniqueIndex("workflow_versions_workspace_id_uq").on(table.workspaceId, table.id),
    index("workflow_versions_workspace_definition_idx").on(table.workspaceId, table.definitionId, table.version),
  ],
);

export const workflowStatusHistory = pgTable(
  "workflow_status_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id").notNull(),
    status: text("status").$type<"PUBLISHED" | "PAUSED" | "ARCHIVED">().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "workflow_status_history_definition_workspace_fk",
      columns: [table.definitionId, table.workspaceId],
      foreignColumns: [workflowDefinitions.id, workflowDefinitions.workspaceId],
    }).onDelete("cascade"),
    index("workflow_status_history_definition_time_idx").on(table.workspaceId, table.definitionId, table.occurredAt),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull().references(() => automationEvents.id, { onDelete: "cascade" }),
    key: automationKey("key"),
    workflowVersionId: uuid("workflow_version_id"),
    occurrenceKey: text("occurrence_key").default("default").notNull(),
    status: automationRunStatus("status").default("PENDING").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("automation_runs_event_key_occurrence_uq").on(table.eventId, table.key, table.occurrenceKey),
    foreignKey({
      name: "automation_runs_workflow_version_workspace_fk",
      columns: [table.workspaceId, table.workflowVersionId],
      foreignColumns: [workflowVersions.workspaceId, workflowVersions.id],
    }),
    uniqueIndex("automation_runs_event_workflow_occurrence_uq")
      .on(table.eventId, table.workflowVersionId, table.occurrenceKey)
      .where(sql`${table.workflowVersionId} is not null`),

    index("automation_runs_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("automation_runs_scheduled_idx").on(table.status, table.scheduledFor),
  ],
);

export const workflowActionRuns = pgTable(
  "workflow_action_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    automationRunId: uuid("automation_run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
    actionIndex: integer("action_index").notNull(),
    actionType: text("action_type").notNull(),
    status: workflowActionRunStatus("status").default("PENDING").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    result: jsonb("result").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workflow_action_runs_run_index_uq").on(table.automationRunId, table.actionIndex),
    uniqueIndex("workflow_action_runs_identity_uq").on(table.id, table.automationRunId, table.workspaceId),
    index("workflow_action_runs_run_status_idx").on(table.automationRunId, table.status, table.actionIndex),
    index("workflow_action_runs_recovery_idx").on(table.status, table.startedAt),
  ],
);

export const automationDeliveries = pgTable(
  "automation_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
    actionRunId: uuid("action_run_id"),
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
    foreignKey({
      name: "automation_deliveries_action_run_fk",
      columns: [table.actionRunId, table.runId, table.workspaceId],
      foreignColumns: [workflowActionRuns.id, workflowActionRuns.automationRunId, workflowActionRuns.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("automation_deliveries_run_channel_recipient_uq")
      .on(table.runId, table.channel, table.recipient)
      .where(sql`${table.actionRunId} is null`),
    uniqueIndex("automation_deliveries_action_channel_recipient_uq")
      .on(table.actionRunId, table.channel, table.recipient)
      .where(sql`${table.actionRunId} is not null`),
    index("automation_deliveries_action_run_idx").on(table.actionRunId),
    index("automation_deliveries_workspace_created_idx").on(table.workspaceId, table.createdAt),
  ],
);


import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts, conversations } from "./core-domain";
import { workspaces } from "./core";
import { capabilityType, integrationMode } from "./integrations";

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    sourceUrl: text("source_url"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("knowledge_sources_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("knowledge_sources_workspace_kind_idx").on(table.workspaceId, table.kind),
  ],
);

export const webchatWidgets = pgTable(
  "webchat_widgets",
  {
    workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    greeting: text("greeting"),
    launcherLabel: text("launcher_label").default("Chat with us").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("webchat_widgets_public_key_uq").on(table.publicKey)],
);

export const webchatSessions = pgTable(
  "webchat_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    visitorId: text("visitor_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webchat_sessions_token_hash_uq").on(table.tokenHash),
    index("webchat_sessions_workspace_visitor_idx").on(table.workspaceId, table.visitorId),
    index("webchat_sessions_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("webchat_sessions_conversation_idx").on(table.conversationId),
  ],
);

export const webchatTurns = pgTable(
  "webchat_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => webchatSessions.id, { onDelete: "cascade" }),
    clientMessageId: uuid("client_message_id").notNull(),
    status: text("status").default("PROCESSING").notNull(),
    responseText: text("response_text"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webchat_turns_session_message_uq").on(table.sessionId, table.clientMessageId),
    index("webchat_turns_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("webchat_turns_session_created_idx").on(table.sessionId, table.createdAt),
  ],
);

export const pendingAgentActions = pgTable(
  "pending_agent_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").default("AWAITING_CONFIRMATION").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "date" }),
    failureCode: text("failure_code"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
  },
  (table) => [
    index("pending_agent_actions_conversation_status_idx").on(table.conversationId, table.status, table.createdAt),
    index("pending_agent_actions_workspace_status_idx").on(table.workspaceId, table.status, table.createdAt),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    capability: capabilityType("capability").notNull(),
    provider: text("provider").notNull(),
    mode: integrationMode("mode").notNull(),
    providerUsage: jsonb("provider_usage").$type<Record<string, unknown>>().default({}).notNull(),
    creditsCharged: integer("credits_charged").default(0).notNull(),
    providerCostMicros: bigint("provider_cost_micros", { mode: "number" }).default(0).notNull(),
    billedUnits: jsonb("billed_units").$type<Record<string, number>>().default({}).notNull(),
    pricingDetails: jsonb("pricing_details").$type<Record<string, unknown>>().default({}).notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("usage_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("usage_events_reference_idx").on(table.workspaceId, table.referenceType, table.referenceId),
    uniqueIndex("usage_events_voice_call_reference_uq")
      .on(table.workspaceId, table.referenceType, table.referenceId)
      .where(sql`${table.referenceType} = 'VOICE_CALL' and ${table.referenceId} is not null`),
    uniqueIndex("usage_events_sms_inbound_reference_uq")
      .on(table.workspaceId, table.referenceType, table.referenceId)
      .where(sql`${table.referenceType} = 'SMS_INBOUND' and ${table.referenceId} is not null`),
    uniqueIndex("usage_events_phone_number_reference_uq")
      .on(table.workspaceId, table.referenceType, table.referenceId)
      .where(sql`${table.referenceType} in ('PHONE_NUMBER_PURCHASE', 'PHONE_NUMBER_RENEWAL') and ${table.referenceId} is not null`),
  ],
);

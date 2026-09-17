import {
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
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("usage_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("usage_events_reference_idx").on(table.workspaceId, table.referenceType, table.referenceId),
  ],
);

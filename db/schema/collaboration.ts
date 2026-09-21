import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { contacts, conversations, messages } from "./core-domain";
import { workspaces } from "./core";

export const conversationHandlingEventType = pgEnum("conversation_handling_event_type", [
  "TAKEOVER",
  "RETURN_TO_AI",
  "ASSIGNED",
  "ESCALATED",
]);

export const conversationHandlingEvents = pgTable(
  "conversation_handling_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    type: conversationHandlingEventType("type").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    assignedUserId: text("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("conversation_handling_events_conversation_idx").on(table.conversationId, table.createdAt),
    index("conversation_handling_events_workspace_idx").on(table.workspaceId, table.createdAt),
  ],
);

export const conversationHumanCases = pgTable(
  "conversation_human_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    fingerprint: text("fingerprint").notNull(),
    reason: text("reason").notNull(),
    status: text("status").default("OPEN").notNull(),
    assignedUserId: text("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("conversation_human_cases_conversation_status_idx").on(table.conversationId, table.status, table.createdAt),
    index("conversation_human_cases_workspace_status_idx").on(table.workspaceId, table.status, table.createdAt),
    uniqueIndex("conversation_human_cases_source_fingerprint_uq")
      .on(table.workspaceId, table.conversationId, table.sourceMessageId, table.fingerprint)
      .where(sql`${table.sourceMessageId} is not null`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("notifications_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("notifications_user_created_idx").on(table.userId, table.createdAt),
  ],
);

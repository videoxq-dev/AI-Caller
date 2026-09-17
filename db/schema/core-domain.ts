import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { services, workspaces } from "./core";
import { integrations } from "./integrations";

export const contactChannel = pgEnum("contact_channel", ["PHONE", "SMS", "WHATSAPP", "WEBCHAT"]);
export const leadStatus = pgEnum("lead_status", ["NEW", "QUALIFIED", "BOOKED", "WON", "LOST"]);
export const conversationStatus = pgEnum("conversation_status", ["OPEN", "CLOSED"]);
export const handlingMode = pgEnum("handling_mode", ["AI", "HUMAN"]);
export const messageDirection = pgEnum("message_direction", ["INBOUND", "OUTBOUND", "INTERNAL"]);
export const messageSenderType = pgEnum("message_sender_type", ["CUSTOMER", "AI", "USER", "SYSTEM"]);
export const messageContentType = pgEnum("message_content_type", ["TEXT", "CALL_TRANSCRIPT", "APPOINTMENT_EVENT", "SYSTEM_EVENT"]);
export const appointmentStatus = pgEnum("appointment_status", ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("contacts_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
    index("contacts_workspace_email_idx").on(table.workspaceId, table.email),
    index("contacts_workspace_phone_idx").on(table.workspaceId, table.phone),
  ],
);

export const contactIdentities = pgTable(
  "contact_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    channel: contactChannel("channel").notNull(),
    externalId: text("external_id").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("contact_identities_workspace_channel_value_uq").on(table.workspaceId, table.channel, table.normalizedValue),
    index("contact_identities_contact_idx").on(table.contactId),
  ],
);

export const contactTags = pgTable(
  "contact_tags",
  {
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [primaryKey({ columns: [table.contactId, table.tag], name: "contact_tags_pk" })],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    status: leadStatus("status").default("NEW").notNull(),
    intent: text("intent"),
    serviceRequested: text("service_requested"),
    source: text("source"),
    estimatedValue: integer("estimated_value"),
    assignedUserId: text("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("leads_workspace_contact_uq").on(table.workspaceId, table.contactId),
    index("leads_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    status: conversationStatus("status").default("OPEN").notNull(),
    handlingMode: handlingMode("handling_mode").default("AI").notNull(),
    assignedUserId: text("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "date" }),
    aiPausedAt: timestamp("ai_paused_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("conversations_workspace_activity_idx").on(table.workspaceId, table.lastMessageAt),
    index("conversations_contact_status_idx").on(table.contactId, table.status),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    channel: contactChannel("channel").notNull(),
    direction: messageDirection("direction").notNull(),
    senderType: messageSenderType("sender_type").notNull(),
    contentType: messageContentType("content_type").default("TEXT").notNull(),
    body: text("body").notNull(),
    provider: text("provider"),
    externalMessageId: text("external_message_id"),
    status: text("status"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    uniqueIndex("messages_workspace_provider_external_uq").on(table.workspaceId, table.provider, table.externalMessageId),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "set null" }),
    externalEventId: text("external_event_id"),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
    timezone: text("timezone").notNull(),
    status: appointmentStatus("status").default("PENDING").notNull(),
    bookingSource: text("booking_source"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("appointments_workspace_start_idx").on(table.workspaceId, table.startsAt),
    index("appointments_contact_start_idx").on(table.contactId, table.startsAt),
    uniqueIndex("appointments_integration_external_uq").on(table.integrationId, table.externalEventId),
  ],
);

import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { services, workspaces } from "./core";
import { integrations } from "./integrations";
import { contactChannel, contacts, conversations } from "./core-domain";

export const bookingDrafts = pgTable("booking_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  sessionKey: text("session_key").notNull(),
  channel: contactChannel("channel").notNull(),
  engineVersion: text("engine_version").default("v2").notNull(),
  status: text("status").default("COLLECTING").notNull(),
  version: integer("version").default(1).notNull(),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
  localDate: text("local_date"),
  localTime: text("local_time"),
  customerTimezone: text("customer_timezone"),
  requiredLocation: text("required_location"),
  originalDateExpression: text("original_date_expression"),
  currentSearchId: uuid("current_search_id"),
  selectedOfferId: uuid("selected_offer_id"),
  currentPreviewId: uuid("current_preview_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("booking_drafts_one_active_session_uq").on(table.workspaceId, table.sessionKey)
    .where(sql`${table.status} IN ('COLLECTING', 'AVAILABILITY_CHECKED', 'AWAITING_CONFIRMATION', 'COMMITTING', 'RECONCILING')`),
  index("booking_drafts_owner_idx").on(table.workspaceId, table.contactId, table.sessionKey, table.createdAt),
  index("booking_drafts_expiry_idx").on(table.expiresAt)
    .where(sql`${table.status} IN ('COLLECTING', 'AVAILABILITY_CHECKED', 'AWAITING_CONFIRMATION')`),
]);

export const bookingSourceEvents = pgTable("booking_source_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  draftId: uuid("draft_id").notNull().references(() => bookingDrafts.id, { onDelete: "cascade" }),
  sessionKey: text("session_key").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  operation: text("operation").notNull(),
  resultVersion: integer("result_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("booking_source_events_dedupe_uq").on(table.workspaceId, table.sessionKey, table.sourceEventId),
  index("booking_source_events_draft_idx").on(table.draftId, table.createdAt),
]);


export const bookingOffers = pgTable("booking_offers", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  draftId: uuid("draft_id").notNull().references(() => bookingDrafts.id, { onDelete: "cascade" }),
  draftVersion: integer("draft_version").notNull(),
  searchId: uuid("search_id").notNull(),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  durationMinutes: integer("duration_minutes").notNull(),
  provider: text("provider").notNull(),
  integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "set null" }),
  bindingFingerprint: text("binding_fingerprint").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  timezone: text("timezone").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  index("booking_offers_search_idx").on(table.workspaceId, table.draftId, table.searchId, table.startsAt),
  index("booking_offers_expiry_idx").on(table.expiresAt),
]);

export const bookingPreviews = pgTable("booking_previews", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  draftId: uuid("draft_id").notNull().references(() => bookingDrafts.id, { onDelete: "cascade" }),
  draftVersion: integer("draft_version").notNull(),
  offerId: uuid("offer_id").notNull().references(() => bookingOffers.id),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  questionType: text("question_type").default("BOOK_APPOINTMENT").notNull(),
  deliveryChannel: text("delivery_channel"),
  deliveryReference: text("delivery_reference"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("booking_previews_draft_version_uq").on(table.draftId, table.draftVersion),
  uniqueIndex("booking_previews_offer_uq").on(table.offerId),
]);

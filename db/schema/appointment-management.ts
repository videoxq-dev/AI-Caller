import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { services, workspaces } from "./core";
import { appointments, contactChannel, contacts, conversations } from "./core-domain";

// This is intentionally separate from booking_drafts. An existing appointment
// must never be turned into a new-booking command by an edit request.
export const appointmentManagementRequests = pgTable("appointment_management_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  sessionKey: text("session_key").notNull(),
  channel: contactChannel("channel").notNull(),
  intent: text("intent").notNull(),
  status: text("status").notNull().default("COLLECTING"),
  version: integer("version").notNull().default(1),
  appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
  originalStartsAt: timestamp("original_starts_at", { withTimezone: true, mode: "date" }),
  originalEndsAt: timestamp("original_ends_at", { withTimezone: true, mode: "date" }),
  originalUpdatedAt: timestamp("original_updated_at", { withTimezone: true, mode: "date" }),
  proposedServiceId: uuid("proposed_service_id").references(() => services.id, { onDelete: "set null" }),
  proposedStartsAt: timestamp("proposed_starts_at", { withTimezone: true, mode: "date" }),
  proposedEndsAt: timestamp("proposed_ends_at", { withTimezone: true, mode: "date" }),
  localDate: text("local_date"),
  localTime: text("local_time"),
  timezone: text("timezone"),
  sourceEventId: text("source_event_id"),
  previewDeliveredAt: timestamp("preview_delivered_at", { withTimezone: true, mode: "date" }),
  previewDeliveryReference: text("preview_delivery_reference"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("appointment_management_one_active_session_uq")
    .on(table.workspaceId, table.sessionKey)
    .where(sql`${table.status} IN ('COLLECTING', 'AWAITING_CONFIRMATION', 'EXECUTING')`),
  index("appointment_management_owner_idx")
    .on(table.workspaceId, table.contactId, table.conversationId, table.updatedAt),
  index("appointment_management_unresolved_appointment_idx")
    .on(table.workspaceId, table.contactId, table.appointmentId, table.updatedAt)
    .where(sql`${table.status} IN ('EXECUTING', 'RECONCILING')`),
  index("appointment_management_expiry_idx")
    .on(table.status, table.expiresAt),
]);

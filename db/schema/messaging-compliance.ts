import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contacts } from "./core-domain";
import { workspaces } from "./core";
import { hostedPhoneNumbers } from "./telephony";

export const smsConsents = pgTable("sms_consents", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  phoneNumber: text("phone_number").notNull(),
  category: text("category").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  sourceReference: text("source_reference"),
  consentStatement: text("consent_statement"),
  grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sms_consents_contact_phone_category_uq").on(table.workspaceId, table.contactId, table.phoneNumber, table.category),
  index("sms_consents_phone_idx").on(table.workspaceId, table.phoneNumber),
]);

// Preserve each consent change; never overwrite the evidence used to make an earlier send decision.
export const smsConsentEvents = pgTable("sms_consent_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  phoneNumber: text("phone_number").notNull(),
  category: text("category").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  sourceReference: text("source_reference"),
  consentStatement: text("consent_statement"),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("sms_consent_events_contact_idx").on(table.workspaceId, table.contactId, table.occurredAt),
]);

export const smsRegistrations = pgTable("sms_registrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  phoneNumberId: uuid("phone_number_id").notNull().references(() => hostedPhoneNumbers.id, { onDelete: "cascade" }),
  numberType: text("number_type").notNull(),
  status: text("status").default("DRAFT").notNull(),
  carrierBrandId: text("carrier_brand_id"),
  carrierCampaignId: text("carrier_campaign_id"),
  carrierVerificationId: text("carrier_verification_id"),
  carrierStatus: text("carrier_status"),
  rejectionReason: text("rejection_reason"),
  // Submitted form and approved scope are separate: editing a draft cannot change live permissions.
  draft: jsonb("draft").$type<Record<string, unknown>>().default({}).notNull(),
  approvedPolicy: jsonb("approved_policy").$type<{ categories: Array<"TRANSACTIONAL" | "MARKETING">; allowEmbeddedLinks: boolean; description: string } | null>(),
  submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
  checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }),
  otpRequestedAt: timestamp("otp_requested_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sms_registrations_number_uq").on(table.phoneNumberId),
  index("sms_registrations_reconcile_idx").on(table.status, table.checkedAt),
]);

/** WhatsApp permissions are channel-specific: SMS consent never authorizes Meta templates. */
export const whatsappConsents = pgTable("whatsapp_consents", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  waId: text("wa_id").notNull(),
  category: text("category").$type<"UTILITY" | "MARKETING">().notNull(),
  status: text("status").$type<"OPTED_IN" | "OPTED_OUT">().notNull(),
  source: text("source").notNull(),
  sourceReference: text("source_reference"),
  consentStatement: text("consent_statement"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, table => [
  uniqueIndex("whatsapp_consents_contact_wa_category_uq").on(table.workspaceId, table.contactId, table.waId, table.category),
  index("whatsapp_consents_destination_idx").on(table.workspaceId, table.waId, table.category),
]);

export const whatsappConsentEvents = pgTable("whatsapp_consent_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  waId: text("wa_id").notNull(),
  category: text("category").$type<"UTILITY" | "MARKETING">().notNull(),
  status: text("status").$type<"OPTED_IN" | "OPTED_OUT">().notNull(),
  source: text("source").notNull(),
  sourceReference: text("source_reference"),
  consentStatement: text("consent_statement"),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, table => [
  index("whatsapp_consent_events_contact_idx").on(table.workspaceId, table.contactId, table.occurredAt),
]);

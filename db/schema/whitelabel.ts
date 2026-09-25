import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const whitelabelBrands = pgTable("whitelabel_brands", {
  id: uuid("id").defaultRandom().primaryKey(),
  purchaserUserId: text("purchaser_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  draft: jsonb("draft").$type<Record<string, unknown>>().default({}).notNull(),
  revision: integer("revision").default(0).notNull(),
  publishedVersion: integer("published_version"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("whitelabel_brands_purchaser_uq").on(table.purchaserUserId),
]);

export const whitelabelBrandVersions = pgTable("whitelabel_brand_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  brandId: uuid("brand_id").notNull().references(() => whitelabelBrands.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  publishedByUserId: text("published_by_user_id").references(() => user.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("whitelabel_brand_versions_brand_version_uq").on(table.brandId, table.version),
  index("whitelabel_brand_versions_brand_idx").on(table.brandId, table.version),
]);

export const whitelabelBrandAssets = pgTable("whitelabel_brand_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  brandId: uuid("brand_id").notNull().references(() => whitelabelBrands.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"LOGO" | "ICON" | "FAVICON">().notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  byteSize: integer("byte_size").notNull(),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  uniqueIndex("whitelabel_brand_assets_object_key_uq").on(table.objectKey),
  index("whitelabel_brand_assets_brand_idx").on(table.brandId, table.kind, table.createdAt),
]);

export type WhitelabelDomainStatus =
  | "DRAFT"
  | "AWAITING_DNS"
  | "VERIFIED"
  | "ROUTE_PROVISIONING"
  | "CERT_PENDING"
  | "CERT_READY"
  | "ACTIVE"
  | "DISABLING"
  | "DISABLED"
  | "REVOKED"
  | "DNS_MISMATCH";

export const whitelabelDomains = pgTable("whitelabel_domains", {
  id: uuid("id").defaultRandom().primaryKey(),
  brandId: uuid("brand_id").notNull().references(() => whitelabelBrands.id, { onDelete: "cascade" }),
  purchaserUserId: text("purchaser_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull(),
  status: text("status").$type<WhitelabelDomainStatus>().notNull(),
  verificationTokenEncrypted: jsonb("verification_token_encrypted").$type<Record<string, unknown>>().notNull(),
  aVerifiedAt: timestamp("a_verified_at", { withTimezone: true, mode: "date" }),
  txtVerifiedAt: timestamp("txt_verified_at", { withTimezone: true, mode: "date" }),
  dnsVerifiedAt: timestamp("dns_verified_at", { withTimezone: true, mode: "date" }),
  routeId: text("route_id"),
  routeProvisionedAt: timestamp("route_provisioned_at", { withTimezone: true, mode: "date" }),
  certificateStatus: text("certificate_status").$type<"NOT_REQUESTED" | "PENDING" | "READY" | "FAILED">().default("NOT_REQUESTED").notNull(),
  certificateReadyAt: timestamp("certificate_ready_at", { withTimezone: true, mode: "date" }),
  certificateExpiresAt: timestamp("certificate_expires_at", { withTimezone: true, mode: "date" }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  uniqueIndex("whitelabel_domains_hostname_active_uq").on(table.hostname)
    .where(sql`${table.status} <> 'DISABLED'`),
  uniqueIndex("whitelabel_domains_brand_active_uq").on(table.brandId)
    .where(sql`${table.status} <> 'DISABLED'`),
  index("whitelabel_domains_purchaser_idx").on(table.purchaserUserId, table.createdAt),
  index("whitelabel_domains_status_idx").on(table.status, table.lastCheckedAt),
]);

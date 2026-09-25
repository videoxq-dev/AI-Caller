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

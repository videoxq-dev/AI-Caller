import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const agencyWorkspaceTemplates = pgTable("agency_workspace_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  purchaserUserId: text("purchaser_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").$type<"ACTIVE" | "ARCHIVED">().default("ACTIVE").notNull(),
  currentVersion: integer("current_version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("agency_workspace_templates_owner_idx").on(table.purchaserUserId, table.status, table.createdAt),
]);

export const agencyWorkspaceTemplateVersions = pgTable("agency_workspace_template_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  templateId: uuid("template_id").notNull().references(() => agencyWorkspaceTemplates.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("agency_workspace_template_versions_template_version_uq").on(table.templateId, table.version),
  index("agency_workspace_template_versions_template_idx").on(table.templateId, table.version),
]);

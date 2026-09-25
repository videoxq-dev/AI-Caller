import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { workspaces } from "./core";
import { agencyWorkspaceTemplates, agencyWorkspaceTemplateVersions } from "./agency-templates";

export const agencyWorkspaceTemplateApplications = pgTable("agency_workspace_template_applications", {
  id: uuid("id").defaultRandom().primaryKey(),
  purchaserUserId: text("purchaser_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  templateId: uuid("template_id").notNull().references(() => agencyWorkspaceTemplates.id),
  templateVersionId: uuid("template_version_id").notNull().references(() => agencyWorkspaceTemplateVersions.id),
  templateVersion: integer("template_version").notNull(),
  requestedName: text("requested_name").notNull(),
  requestKey: uuid("request_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("agency_workspace_template_applications_workspace_uq").on(table.workspaceId),
  uniqueIndex("agency_workspace_template_applications_request_uq").on(table.purchaserUserId, table.requestKey),
  index("agency_workspace_template_applications_owner_idx").on(table.purchaserUserId, table.createdAt),
]);

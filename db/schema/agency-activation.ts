import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { workspaces } from "./core";

export const agencyTemplateActivationReviews = pgTable("agency_template_activation_reviews", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  reviewerUserId: text("reviewer_user_id").notNull().references(() => user.id),
  configurationHash: text("configuration_hash").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

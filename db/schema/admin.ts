import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const platformAdmins = pgTable("platform_admins", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  role: text("role").default("ADMIN").notNull(),
  active: boolean("active").default(true).notNull(),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const userAdminStates = pgTable("user_admin_states", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  status: text("status").default("ACTIVE").notNull(),
  reason: text("reason"),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("admin_audit_created_idx").on(table.createdAt),
    index("admin_audit_target_idx").on(table.targetType, table.targetId, table.createdAt),
    index("admin_audit_actor_idx").on(table.actorUserId, table.createdAt),
  ],
);

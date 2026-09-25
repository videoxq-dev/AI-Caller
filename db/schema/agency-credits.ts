import {
  index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { workspaces } from "./core";

export const agencyCreditPools = pgTable("agency_credit_pools", {
  purchaserUserId: text("purchaser_user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  balance: integer("balance").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const agencyCreditPoolLedger = pgTable("agency_credit_pool_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  purchaserUserId: text("purchaser_user_id").notNull()
    .references(() => agencyCreditPools.purchaserUserId, { onDelete: "cascade" }),
  type: text("type").$type<"PURCHASE" | "ALLOCATION" | "ADJUSTMENT">().notNull(),
  amount: integer("amount").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  reason: text("reason").notNull(),
  referenceType: text("reference_type").notNull(),
  referenceId: text("reference_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("agency_credit_pool_ledger_reference_uq").on(
    table.purchaserUserId, table.type, table.referenceType, table.referenceId,
  ),
  index("agency_credit_pool_ledger_created_idx").on(table.purchaserUserId, table.createdAt),
]);

export const agencyCreditAllocations = pgTable("agency_credit_allocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  purchaserUserId: text("purchaser_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  idempotencyKey: uuid("idempotency_key").notNull(),
  amount: integer("amount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("agency_credit_allocations_idempotency_uq").on(table.purchaserUserId, table.idempotencyKey),
  index("agency_credit_allocations_target_idx").on(table.workspaceId, table.createdAt),
]);

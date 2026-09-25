import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { workspaces } from "./core";
import { capabilityType } from "./integrations";

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").default(true).notNull(),
  subUserLimit: integer("sub_user_limit").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const workspacePlans = pgTable(
  "workspace_plans",
  {
    workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull().references(() => plans.id),
    source: text("source").default("SYSTEM").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("workspace_plans_plan_idx").on(table.planId)],
);

export const hostedApiRateCards = pgTable(
  "hosted_api_rate_cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    capability: capabilityType("capability").notNull(),
    provider: text("provider").notNull(),
    model: text("model").default("").notNull(),
    unit: text("unit").notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    unitsPerCost: integer("units_per_cost").notNull(),
    targetMarginBps: integer("target_margin_bps").default(5000).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("hosted_api_rate_cards_version_uq").on(
      table.capability,
      table.provider,
      table.model,
      table.unit,
      table.effectiveFrom,
    ),
    index("hosted_api_rate_cards_lookup_idx").on(
      table.capability,
      table.provider,
      table.model,
      table.enabled,
      table.effectiveFrom,
    ),
  ],
);

export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    status: text("status").default("ACTIVE").notNull(),
    actualAmount: integer("actual_amount"),
    referenceType: text("reference_type").notNull(),
    referenceId: text("reference_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("credit_reservations_reference_uq").on(
      table.workspaceId,
      table.referenceType,
      table.referenceId,
    ),
    index("credit_reservations_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const creditPacks = pgTable("credit_packs", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  credits: integer("credits").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").default("usd").notNull(),
  active: boolean("active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const creditTopups = pgTable(
  "credit_topups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    fundingDestination: text("funding_destination").$type<"WORKSPACE" | "AGENCY_POOL">().default("WORKSPACE").notNull(),
    agencyPurchaserUserId: text("agency_purchaser_user_id").references(() => user.id),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    packCode: text("pack_code").notNull().references(() => creditPacks.code),
    credits: integer("credits").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: text("status").default("PENDING").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    stripeDisputeId: text("stripe_dispute_id"),
    refundedAmountCents: integer("refunded_amount_cents").default(0).notNull(),
    disputedAmountCents: integer("disputed_amount_cents").default(0).notNull(),
    reversedCredits: integer("reversed_credits").default(0).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("credit_topups_workspace_created_idx").on(table.workspaceId, table.createdAt),
    uniqueIndex("credit_topups_stripe_session_uq").on(table.stripeCheckoutSessionId),
    uniqueIndex("credit_topups_stripe_payment_intent_uq").on(table.stripePaymentIntentId),
    index("credit_topups_stripe_charge_idx").on(table.stripeChargeId),
  ],
);

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  status: text("status").default("RECEIVED").notNull(),
  error: text("error"),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
});

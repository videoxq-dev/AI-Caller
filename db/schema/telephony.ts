import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./core";

export const hostedPhoneNumbers = pgTable(
  "hosted_phone_numbers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").default("telnyx").notNull(),
    providerNumberId: text("provider_number_id"),
    providerOrderId: text("provider_order_id"),
    providerOrderStatus: text("provider_order_status"),
    provisionRequestId: uuid("provision_request_id"),
    phoneNumber: text("phone_number").notNull(),
    countryCode: text("country_code").notNull(),
    administrativeArea: text("administrative_area"),
    locality: text("locality"),
    numberType: text("number_type").default("local").notNull(),
    status: text("status").default("PROVISIONING").notNull(),
    messagingReadiness: text("messaging_readiness").default("NOT_REGISTERED").notNull(),
    providerMonthlyCostMicros: bigint("provider_monthly_cost_micros", { mode: "number" }).notNull(),
    providerUpfrontCostMicros: bigint("provider_upfront_cost_micros", { mode: "number" }).default(0).notNull(),
    monthlyCredits: integer("monthly_credits").notNull(),
    purchaseCredits: integer("purchase_credits").notNull(),
    voiceConnectionId: text("voice_connection_id"),
    messagingProfileId: text("messaging_profile_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: "date" }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }),
    nextBillingAt: timestamp("next_billing_at", { withTimezone: true, mode: "date" }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true, mode: "date" }),
    provisioningLastCheckedAt: timestamp("provisioning_last_checked_at", { withTimezone: true, mode: "date" }),
    reconcileAfter: timestamp("reconcile_after", { withTimezone: true, mode: "date" }),
    failureReason: text("failure_reason"),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("hosted_phone_numbers_workspace_status_idx").on(table.workspaceId, table.status),
    index("hosted_phone_numbers_due_idx").on(table.status, table.nextBillingAt),
    index("hosted_phone_numbers_reconcile_idx").on(table.status, table.reconcileAfter),
    uniqueIndex("hosted_phone_numbers_provider_id_uq")
      .on(table.provider, table.providerNumberId)
      .where(sql`${table.providerNumberId} IS NOT NULL`),
    uniqueIndex("hosted_phone_numbers_provision_request_uq")
      .on(table.workspaceId, table.provisionRequestId)
      .where(sql`${table.provisionRequestId} IS NOT NULL`),
    uniqueIndex("hosted_phone_numbers_active_number_uq")
      .on(table.phoneNumber)
      .where(sql`${table.releasedAt} IS NULL`),
  ],
);

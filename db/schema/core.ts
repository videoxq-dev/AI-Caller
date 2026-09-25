import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const workspaceStatus = pgEnum("workspace_status", ["ACTIVE", "SUSPENDED"]);
export const membershipRole = pgEnum("membership_role", ["OWNER", "ADMIN", "STAFF"]);
export const workspaceInvitationStatus = pgEnum("workspace_invitation_status", ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]);
export const licenseSource = pgEnum("license_source", ["JVZOO", "MANUAL"]);
export const licenseStatus = pgEnum("license_status", ["ACTIVE", "REFUNDED", "CHARGEBACK", "CANCELLED"]);
export const aiAgentStatus = pgEnum("ai_agent_status", ["DRAFT", "ACTIVE", "PAUSED"]);
export const creditLedgerType = pgEnum("credit_ledger_type", ["GRANT", "PURCHASE", "DEBIT", "REFUND", "ADJUSTMENT"]);
export const commerceEventStatus = pgEnum("commerce_event_status", ["RECEIVED", "PROCESSED", "IGNORED", "FAILED"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  status: workspaceStatus("status").default("ACTIVE").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: membershipRole("role").default("STAFF").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId], name: "memberships_pk" }),
    index("memberships_user_idx").on(table.userId),
  ],
);

export const workspaceCommercialOwners = pgTable(
  "workspace_commercial_owners",
  {
    workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    purchaserUserId: text("purchaser_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"PRIMARY" | "ADDITIONAL">().notNull(),
    agencyClient: boolean("agency_client").default(false).notNull(),
    provisioningSource: text("provisioning_source").$type<"PRIMARY" | "UNLIMITED" | "AGENCY" | "LEGACY">().default("LEGACY").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("workspace_commercial_owners_purchaser_idx")
      .on(table.purchaserUserId, table.kind, table.createdAt),
  ],
);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: membershipRole("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: workspaceInvitationStatus("status").default("PENDING").notNull(),
    invitedByUserId: text("invited_by_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("workspace_invitations_workspace_idx").on(table.workspaceId, table.createdAt),
    index("workspace_invitations_email_idx").on(table.email),
    uniqueIndex("workspace_invitations_workspace_email_pending_uq")
      .on(table.workspaceId, table.email)
      .where(sql`${table.status} = 'PENDING'`),
  ],
);

export const licenses = pgTable(
  "licenses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    purchaserUserId: text("purchaser_user_id").references(() => user.id, { onDelete: "set null" }),
    source: licenseSource("source").notNull(),
    externalPurchaseId: text("external_purchase_id").notNull(),
    productCode: text("product_code").notNull(),
    status: licenseStatus("status").default("ACTIVE").notNull(),
    purchasedAt: timestamp("purchased_at", { withTimezone: true, mode: "date" }).notNull(),
    rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("licenses_source_purchase_product_uq").on(table.source, table.externalPurchaseId, table.productCode),
    index("licenses_workspace_idx").on(table.workspaceId),
    index("licenses_purchaser_status_idx").on(table.purchaserUserId, table.status, table.productCode),
  ],
);

export const workspaceEntitlements = pgTable(
  "workspace_entitlements",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.key], name: "workspace_entitlements_pk" })],
);

export const businessProfiles = pgTable("business_profiles", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull(),
  industry: text("industry"),
  websiteUrl: text("website_url"),
  phone: text("phone"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),
  serviceRadius: text("service_radius"),
  timezone: text("timezone").default("UTC").notNull(),
  summary: text("summary"),
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const businessHours = pgTable(
  "business_hours",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    dayOfWeek: integer("day_of_week").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    openTime: text("open_time"),
    closeTime: text("close_time"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.dayOfWeek], name: "business_hours_pk" })],
);

export const aiAgents = pgTable(
  "ai_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").default("AI Assistant").notNull(),
    status: aiAgentStatus("status").default("DRAFT").notNull(),
    tone: text("tone").default("Friendly & professional").notNull(),
    primaryGoal: text("primary_goal").default("Book appointments").notNull(),
    whenUnsure: text("when_unsure").default("Escalate to a human").notNull(),
    advancedInstructions: text("advanced_instructions"),
    openingMessage: text("opening_message"),
    escalationMessage: text("escalation_message"),
    behaviorSettings: jsonb("behavior_settings").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("ai_agents_workspace_uq").on(table.workspaceId)],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    priceText: text("price_text"),
    durationMinutes: integer("duration_minutes"),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("services_workspace_idx").on(table.workspaceId)],
);

export const faqs = pgTable(
  "faqs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("faqs_workspace_idx").on(table.workspaceId)],
);

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("policies_workspace_idx").on(table.workspaceId)],
);

export const setupProgress = pgTable("setup_progress", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  businessCompletedAt: timestamp("business_completed_at", { withTimezone: true, mode: "date" }),
  aiCompletedAt: timestamp("ai_completed_at", { withTimezone: true, mode: "date" }),
  communicationCompletedAt: timestamp("communication_completed_at", { withTimezone: true, mode: "date" }),
  calendarCompletedAt: timestamp("calendar_completed_at", { withTimezone: true, mode: "date" }),
  testCompletedAt: timestamp("test_completed_at", { withTimezone: true, mode: "date" }),
  liveCompletedAt: timestamp("live_completed_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const creditWallets = pgTable("credit_wallets", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  balance: integer("balance").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    type: creditLedgerType("type").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason").notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("credit_ledger_workspace_idx").on(table.workspaceId),
    index("credit_ledger_workspace_created_idx").on(table.workspaceId, table.createdAt),
    uniqueIndex("credit_ledger_reference_uq").on(table.workspaceId, table.type, table.referenceType, table.referenceId),
  ],
);

export const commerceEvents = pgTable(
  "commerce_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: licenseSource("source").notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: commerceEventStatus("status").default("RECEIVED").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("commerce_events_source_external_uq").on(table.source, table.externalEventId)],
);

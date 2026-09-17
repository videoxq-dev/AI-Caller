import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./core";

export const integrationCategory = pgEnum("integration_category", ["AI", "COMMUNICATION", "WHATSAPP", "CALENDAR"]);
export const integrationMode = pgEnum("integration_mode", ["HOSTED", "BYOP"]);
export const integrationStatus = pgEnum("integration_status", ["CONNECTED", "ERROR", "DISCONNECTED"]);
export const capabilityType = pgEnum("capability_type", ["AI_TEXT", "SMS", "VOICE", "WHATSAPP", "CALENDAR"]);

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    category: integrationCategory("category").notNull(),
    provider: text("provider").notNull(),
    mode: integrationMode("mode").default("BYOP").notNull(),
    status: integrationStatus("status").default("DISCONNECTED").notNull(),
    encryptedCredentials: jsonb("encrypted_credentials").$type<Record<string, unknown> | null>(),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("integrations_workspace_provider_uq").on(table.workspaceId, table.provider),
    index("integrations_workspace_category_idx").on(table.workspaceId, table.category),
  ],
);

export const capabilityBindings = pgTable(
  "capability_bindings",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    capability: capabilityType("capability").notNull(),
    integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "set null" }),
    mode: integrationMode("mode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.capability], name: "capability_bindings_pk" })],
);

export const communicationSetupSettings = pgTable("communication_setup_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const calendarSetupSettings = pgTable("calendar_setup_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

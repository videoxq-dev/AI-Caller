import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./core";

export const providerWebhookEvents = pgTable(
  "provider_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    status: text("status").default("RECEIVED").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("provider_webhook_events_workspace_provider_external_uq").on(table.workspaceId, table.provider, table.externalEventId),
    index("provider_webhook_events_workspace_received_idx").on(table.workspaceId, table.receivedAt),
    index("provider_webhook_events_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

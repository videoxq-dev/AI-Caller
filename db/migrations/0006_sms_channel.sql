CREATE TABLE "provider_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_event_id" text NOT NULL,
  "status" text DEFAULT 'PROCESSING' NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "received_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz
);
CREATE UNIQUE INDEX "provider_webhook_events_provider_external_uq" ON "provider_webhook_events" ("provider", "external_event_id");
CREATE INDEX "provider_webhook_events_workspace_received_idx" ON "provider_webhook_events" ("workspace_id", "received_at");
CREATE INDEX "provider_webhook_events_workspace_status_idx" ON "provider_webhook_events" ("workspace_id", "status");

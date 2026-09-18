CREATE TYPE "automation_key" AS ENUM (
  'MISSED_INQUIRY_RECOVERY',
  'QUALIFIED_LEAD_ASSIGNMENT',
  'APPOINTMENT_CONFIRMATION',
  'APPOINTMENT_REMINDER',
  'HUMAN_ESCALATION'
);
CREATE TYPE "automation_event_type" AS ENUM (
  'INQUIRY_RECEIVED',
  'LEAD_QUALIFIED',
  'APPOINTMENT_CONFIRMED',
  'APPOINTMENT_RESCHEDULED',
  'APPOINTMENT_CANCELLED',
  'CONVERSATION_ESCALATED'
);
CREATE TYPE "automation_run_status" AS ENUM ('PENDING','RUNNING','COMPLETED','SKIPPED','FAILED');
CREATE TYPE "automation_delivery_status" AS ENUM ('PENDING','SENT','SKIPPED','FAILED','UNKNOWN');

CREATE TABLE "automation_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" "automation_key" NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "automation_settings_workspace_key_uq" ON "automation_settings" ("workspace_id","key");

CREATE TABLE "automation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "type" "automation_event_type" NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "occurrence_key" text NOT NULL DEFAULT 'default',
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "dispatched_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "automation_events_workspace_occurrence_uq"
ON "automation_events" ("workspace_id","type","aggregate_type","aggregate_id","occurrence_key");
CREATE INDEX "automation_events_dispatch_idx" ON "automation_events" ("dispatched_at","created_at");

CREATE TABLE "automation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "automation_events"("id") ON DELETE CASCADE,
  "key" "automation_key" NOT NULL,
  "occurrence_key" text NOT NULL DEFAULT 'default',
  "status" "automation_run_status" NOT NULL DEFAULT 'PENDING',
  "scheduled_for" timestamptz,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "error_code" text,
  "error_message" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "automation_runs_event_key_occurrence_uq"
ON "automation_runs" ("event_id","key","occurrence_key");
CREATE INDEX "automation_runs_workspace_created_idx" ON "automation_runs" ("workspace_id","created_at");
CREATE INDEX "automation_runs_scheduled_idx" ON "automation_runs" ("status","scheduled_for");

CREATE TABLE "automation_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "automation_runs"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "recipient" text NOT NULL,
  "status" "automation_delivery_status" NOT NULL DEFAULT 'PENDING',
  "message_id" uuid,
  "provider_external_id" text,
  "error_code" text,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "automation_deliveries_run_channel_recipient_uq"
ON "automation_deliveries" ("run_id","channel","recipient");
CREATE INDEX "automation_deliveries_workspace_created_idx"
ON "automation_deliveries" ("workspace_id","created_at");

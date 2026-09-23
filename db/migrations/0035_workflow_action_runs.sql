-- Phase 3C: durable multi-action workflow execution with pause history and action-aware deliveries.

ALTER TYPE "automation_run_status" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE TYPE "workflow_action_run_status" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'SKIPPED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED'
);

CREATE TABLE "workflow_status_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "definition_id" uuid NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('PUBLISHED', 'PAUSED', 'ARCHIVED')),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_status_history_definition_workspace_fk"
    FOREIGN KEY ("definition_id", "workspace_id")
    REFERENCES "workflow_definitions" ("id", "workspace_id") ON DELETE CASCADE
);
CREATE INDEX "workflow_status_history_definition_time_idx"
  ON "workflow_status_history" ("workspace_id", "definition_id", "occurred_at" DESC);

-- Backfill the activation boundary for definitions published before this migration.
INSERT INTO "workflow_status_history" ("workspace_id", "definition_id", "status", "occurred_at")
SELECT d."workspace_id", d."id", 'PUBLISHED', MIN(v."published_at")
FROM "workflow_definitions" d
JOIN "workflow_versions" v
  ON v."workspace_id" = d."workspace_id"
 AND v."definition_id" = d."id"
WHERE d."published_version" IS NOT NULL
GROUP BY d."workspace_id", d."id";

-- Preserve current paused/archived state after recording the original publication boundary.
INSERT INTO "workflow_status_history" ("workspace_id", "definition_id", "status", "occurred_at")
SELECT d."workspace_id", d."id", d."status", d."updated_at"
FROM "workflow_definitions" d
WHERE d."status" IN ('PAUSED', 'ARCHIVED')
  AND d."published_version" IS NOT NULL;

ALTER TABLE "automation_runs"
  ADD COLUMN "cancel_requested_at" timestamptz;

CREATE TABLE "workflow_action_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "automation_run_id" uuid NOT NULL REFERENCES "automation_runs" ("id") ON DELETE CASCADE,
  "action_index" integer NOT NULL CHECK ("action_index" >= 0 AND "action_index" < 5),
  "action_type" text NOT NULL,
  "status" "workflow_action_run_status" NOT NULL DEFAULT 'PENDING',
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "error_code" text,
  "error_message" text,
  "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_action_runs_run_index_uq" UNIQUE ("automation_run_id", "action_index"),
  CONSTRAINT "workflow_action_runs_identity_uq" UNIQUE ("id", "automation_run_id", "workspace_id")
);
CREATE INDEX "workflow_action_runs_run_status_idx"
  ON "workflow_action_runs" ("automation_run_id", "status", "action_index");
CREATE INDEX "workflow_action_runs_recovery_idx"
  ON "workflow_action_runs" ("status", "started_at");

ALTER TABLE "automation_deliveries"
  ADD COLUMN "action_run_id" uuid;

ALTER TABLE "automation_deliveries"
  ADD CONSTRAINT "automation_deliveries_action_run_fk"
  FOREIGN KEY ("action_run_id", "run_id", "workspace_id")
  REFERENCES "workflow_action_runs" ("id", "automation_run_id", "workspace_id")
  ON DELETE CASCADE;

DROP INDEX "automation_deliveries_run_channel_recipient_uq";

CREATE UNIQUE INDEX "automation_deliveries_run_channel_recipient_uq"
  ON "automation_deliveries" ("run_id", "channel", "recipient")
  WHERE "action_run_id" IS NULL;

CREATE UNIQUE INDEX "automation_deliveries_action_channel_recipient_uq"
  ON "automation_deliveries" ("action_run_id", "channel", "recipient")
  WHERE "action_run_id" IS NOT NULL;

CREATE INDEX "automation_deliveries_action_run_idx"
  ON "automation_deliveries" ("action_run_id");

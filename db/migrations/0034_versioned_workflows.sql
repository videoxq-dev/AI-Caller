-- Phase 3B: additive, versioned deterministic workflows; legacy recipes retain their writer.
CREATE TABLE "workflow_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'DRAFT'
    CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'PAUSED', 'ARCHIVED')),
  "draft" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "published_version" integer CHECK ("published_version" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_definitions_id_workspace_uq" UNIQUE ("id", "workspace_id")
);
CREATE INDEX "workflow_definitions_workspace_status_idx"
  ON "workflow_definitions" ("workspace_id", "status");

CREATE TABLE "workflow_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "definition_id" uuid NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "snapshot" jsonb NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_versions_definition_workspace_fk" FOREIGN KEY ("definition_id", "workspace_id")
    REFERENCES "workflow_definitions" ("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "workflow_versions_definition_version_uq" UNIQUE ("definition_id", "version"),
  CONSTRAINT "workflow_versions_workspace_id_uq" UNIQUE ("workspace_id", "id")
);
CREATE INDEX "workflow_versions_workspace_definition_idx"
  ON "workflow_versions" ("workspace_id", "definition_id", "version");

ALTER TABLE "automation_runs" ALTER COLUMN "key" DROP NOT NULL;
ALTER TABLE "automation_runs" ADD COLUMN "workflow_version_id" uuid;
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workflow_version_workspace_fk"
  FOREIGN KEY ("workspace_id", "workflow_version_id")
  REFERENCES "workflow_versions" ("workspace_id", "id");
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_recipe_or_workflow_ck"
  CHECK (("key" IS NOT NULL AND "workflow_version_id" IS NULL)
    OR ("key" IS NULL AND "workflow_version_id" IS NOT NULL));
CREATE UNIQUE INDEX "automation_runs_event_workflow_occurrence_uq"
  ON "automation_runs" ("event_id", "workflow_version_id", "occurrence_key")
  WHERE "workflow_version_id" IS NOT NULL;

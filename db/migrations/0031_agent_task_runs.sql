CREATE TABLE "agent_task_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "source_message_id" uuid,
  "task_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'RUNNING'
    CHECK ("status" IN ('RUNNING','WAITING_CUSTOMER','WAITING_CONFIRMATION','WAITING_SYSTEM','COMPLETED','FAILED')),
  "objective" text,
  "termination_reason" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "agent_task_runs_task_key_uq"
  ON "agent_task_runs" ("workspace_id","conversation_id","task_key");
CREATE INDEX "agent_task_runs_source_message_idx"
  ON "agent_task_runs" ("workspace_id","conversation_id","source_message_id");
CREATE INDEX "agent_task_runs_workspace_status_idx"
  ON "agent_task_runs" ("workspace_id","status","started_at");
CREATE INDEX "agent_task_runs_conversation_idx"
  ON "agent_task_runs" ("conversation_id","started_at");

CREATE TABLE "agent_task_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "agent_task_runs"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "action" text NOT NULL,
  "risk" text NOT NULL CHECK ("risk" IN ('READ_ONLY','MUTATING','CONSEQUENTIAL')),
  "status" text NOT NULL DEFAULT 'RUNNING'
    CHECK ("status" IN ('RUNNING','COMPLETED','FAILED')),
  "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "input_hash" text NOT NULL,
  "idempotency_key" text,
  "result" jsonb,
  "error_code" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);

CREATE UNIQUE INDEX "agent_task_steps_run_sequence_uq"
  ON "agent_task_steps" ("run_id","sequence");
CREATE UNIQUE INDEX "agent_task_steps_run_idempotency_uq"
  ON "agent_task_steps" ("run_id","idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "agent_task_steps_workspace_action_idx"
  ON "agent_task_steps" ("workspace_id","action","started_at");

CREATE TABLE "conversation_human_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "source_message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL,
  "fingerprint" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'OPEN',
  "assigned_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz
);

CREATE INDEX "conversation_human_cases_conversation_status_idx"
ON "conversation_human_cases" ("conversation_id", "status", "created_at");
CREATE INDEX "conversation_human_cases_workspace_status_idx"
ON "conversation_human_cases" ("workspace_id", "status", "created_at");
CREATE UNIQUE INDEX "conversation_human_cases_source_fingerprint_uq"
ON "conversation_human_cases" ("workspace_id", "conversation_id", "source_message_id", "fingerprint")
WHERE "source_message_id" IS NOT NULL;

CREATE TABLE "pending_agent_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "confirmed_at" timestamptz,
  "executed_at" timestamptz,
  "failure_code" text
);

CREATE INDEX "pending_agent_actions_conversation_status_idx"
ON "pending_agent_actions" ("conversation_id", "status", "created_at");
CREATE INDEX "pending_agent_actions_workspace_status_idx"
ON "pending_agent_actions" ("workspace_id", "status", "created_at");
CREATE UNIQUE INDEX "pending_agent_actions_one_awaiting_type_uq"
ON "pending_agent_actions" ("workspace_id", "conversation_id", "type")
WHERE "status" = 'AWAITING_CONFIRMATION';

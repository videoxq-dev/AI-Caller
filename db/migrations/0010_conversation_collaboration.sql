CREATE TYPE "conversation_handling_event_type" AS ENUM ('TAKEOVER', 'RETURN_TO_AI', 'ASSIGNED', 'ESCALATED');

CREATE TABLE "conversation_handling_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "type" "conversation_handling_event_type" NOT NULL,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "assigned_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "reason" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "conversation_handling_events_conversation_idx"
ON "conversation_handling_events" ("conversation_id", "created_at");
CREATE INDEX "conversation_handling_events_workspace_idx"
ON "conversation_handling_events" ("workspace_id", "created_at");

CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE CASCADE,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE CASCADE,
  "read_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "notifications_workspace_created_idx"
ON "notifications" ("workspace_id", "created_at");
CREATE INDEX "notifications_user_created_idx"
ON "notifications" ("user_id", "created_at");

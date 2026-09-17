CREATE TABLE "webchat_widgets" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "public_key" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "greeting" text,
  "launcher_label" text DEFAULT 'Chat with us' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "webchat_widgets_public_key_uq" ON "webchat_widgets" ("public_key");

CREATE TABLE "webchat_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "visitor_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "webchat_sessions_token_hash_uq" ON "webchat_sessions" ("token_hash");
CREATE INDEX "webchat_sessions_workspace_visitor_idx" ON "webchat_sessions" ("workspace_id", "visitor_id");
CREATE INDEX "webchat_sessions_conversation_idx" ON "webchat_sessions" ("conversation_id");

CREATE TABLE "webchat_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "webchat_sessions"("id") ON DELETE CASCADE,
  "client_message_id" uuid NOT NULL,
  "status" text DEFAULT 'PROCESSING' NOT NULL,
  "response_text" text,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "webchat_turns_session_message_uq" ON "webchat_turns" ("session_id", "client_message_id");
CREATE INDEX "webchat_turns_workspace_created_idx" ON "webchat_turns" ("workspace_id", "created_at");

CREATE TABLE "usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "capability" "capability_type" NOT NULL,
  "provider" text NOT NULL,
  "mode" "integration_mode" NOT NULL,
  "provider_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "credits_charged" integer DEFAULT 0 NOT NULL,
  "reference_type" text,
  "reference_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "usage_events_workspace_created_idx" ON "usage_events" ("workspace_id", "created_at");
CREATE INDEX "usage_events_reference_idx" ON "usage_events" ("workspace_id", "reference_type", "reference_id");

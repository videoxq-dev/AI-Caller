CREATE TABLE IF NOT EXISTS "workspace_voice_technology" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "technology" text NOT NULL DEFAULT 'STANDARD'
    CHECK ("technology" IN ('STANDARD','REALTIME')),
  "realtime_model" text NOT NULL DEFAULT 'gpt-realtime-2.1'
    CHECK ("realtime_model" IN ('gpt-realtime-2.1','gpt-realtime-2.1-mini')),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "voice_realtime_response_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "voice_call_id" uuid NOT NULL REFERENCES "voice_calls"("id") ON DELETE CASCADE,
  "response_id" text NOT NULL,
  "usage" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("voice_call_id", "response_id")
);
CREATE INDEX IF NOT EXISTS "voice_realtime_response_usage_workspace_call_idx"
  ON "voice_realtime_response_usage" ("workspace_id","voice_call_id");

CREATE TABLE IF NOT EXISTS "voice_realtime_booking_state" (
  "voice_call_id" uuid PRIMARY KEY REFERENCES "voice_calls"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "available_start" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "voice_realtime_booking_state_workspace_idx"
  ON "voice_realtime_booking_state" ("workspace_id");

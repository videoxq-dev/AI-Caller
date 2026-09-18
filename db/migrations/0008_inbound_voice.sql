ALTER TYPE "message_content_type" ADD VALUE 'CALL_RECORDING';

ALTER TABLE "leads"
ADD COLUMN "qualification_data" jsonb NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN "qualification_score" integer NOT NULL DEFAULT 0,
ADD COLUMN "qualification_completed_at" timestamptz;

CREATE TYPE "voice_call_mode" AS ENUM ('AI_FIRST', 'AFTER_HOURS', 'OVERFLOW');
CREATE TYPE "voice_call_status" AS ENUM ('RINGING', 'ACTIVE', 'COMPLETED', 'FAILED');
CREATE TYPE "voice_recording_status" AS ENUM ('PENDING', 'RECORDING', 'AVAILABLE', 'FAILED', 'DECLINED');
CREATE TYPE "voice_recording_consent_status" AS ENUM ('NOT_REQUIRED', 'ANNOUNCED', 'GRANTED', 'DECLINED');
CREATE TYPE "voice_transcript_status" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETE', 'FAILED');
CREATE TYPE "voice_transcript_speaker" AS ENUM ('CUSTOMER', 'AI', 'HUMAN');

CREATE TABLE "voice_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "integration_id" uuid REFERENCES "integrations"("id") ON DELETE SET NULL,
  "provider" text NOT NULL,
  "external_call_id" text NOT NULL,
  "call_control_id" text,
  "from_number" text NOT NULL,
  "to_number" text NOT NULL,
  "mode" "voice_call_mode" NOT NULL DEFAULT 'AI_FIRST',
  "status" "voice_call_status" NOT NULL DEFAULT 'RINGING',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "answered_at" timestamptz,
  "ended_at" timestamptz,
  "duration_seconds" integer,
  "recording_status" "voice_recording_status" NOT NULL DEFAULT 'PENDING',
  "recording_external_id" text,
  "recording_object_key" text,
  "recording_mime_type" text,
  "recording_duration_seconds" integer,
  "recording_consent_status" "voice_recording_consent_status" NOT NULL DEFAULT 'ANNOUNCED',
  "recording_disclosure_version" text,
  "recording_disclosed_at" timestamptz,
  "transcript_status" "voice_transcript_status" NOT NULL DEFAULT 'PENDING',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "voice_calls_workspace_provider_external_uq"
ON "voice_calls" ("workspace_id", "provider", "external_call_id");
CREATE INDEX "voice_calls_workspace_started_idx"
ON "voice_calls" ("workspace_id", "started_at");
CREATE INDEX "voice_calls_conversation_started_idx"
ON "voice_calls" ("conversation_id", "started_at");

CREATE TABLE "voice_transcript_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "voice_call_id" uuid NOT NULL REFERENCES "voice_calls"("id") ON DELETE CASCADE,
  "speaker" "voice_transcript_speaker" NOT NULL,
  "text" text NOT NULL,
  "started_ms" integer,
  "ended_ms" integer,
  "sequence" integer NOT NULL,
  "confidence_bps" integer,
  "external_event_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "voice_transcript_call_sequence_uq"
ON "voice_transcript_segments" ("voice_call_id", "sequence");
CREATE UNIQUE INDEX "voice_transcript_workspace_external_event_uq"
ON "voice_transcript_segments" ("workspace_id", "external_event_id")
WHERE "external_event_id" IS NOT NULL;
CREATE INDEX "voice_transcript_call_created_idx"
ON "voice_transcript_segments" ("voice_call_id", "created_at");

-- Durable booking intent only. No existing pending action is executed or migrated.
-- The new engine is not enabled until confirmation/commit/reconciliation are wired.
CREATE TABLE "booking_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
  "session_key" text NOT NULL,
  "channel" "contact_channel" NOT NULL,
  "engine_version" text NOT NULL DEFAULT 'v2',
  "status" text NOT NULL DEFAULT 'COLLECTING',
  "version" integer NOT NULL DEFAULT 1,
  "service_id" uuid REFERENCES "services"("id") ON DELETE SET NULL,
  "local_date" text,
  "local_time" text,
  "customer_timezone" text,
  "required_location" text,
  "original_date_expression" text,
  "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "booking_drafts_version_positive" CHECK ("version" > 0),
  CONSTRAINT "booking_drafts_status_valid" CHECK ("status" IN (
    'COLLECTING', 'AVAILABILITY_CHECKED', 'AWAITING_CONFIRMATION',
    'COMMITTING', 'RECONCILING', 'CONFIRMED', 'FAILED',
    'CANCELLED', 'EXPIRED', 'SUPERSEDED'
  )),
  CONSTRAINT "booking_drafts_session_key_nonempty" CHECK (length("session_key") BETWEEN 1 AND 300)
);
CREATE UNIQUE INDEX "booking_drafts_one_active_session_uq"
  ON "booking_drafts" ("workspace_id", "session_key")
  WHERE "status" IN ('COLLECTING', 'AVAILABILITY_CHECKED', 'AWAITING_CONFIRMATION', 'COMMITTING', 'RECONCILING');
CREATE INDEX "booking_drafts_owner_idx"
  ON "booking_drafts" ("workspace_id", "contact_id", "session_key", "created_at");
CREATE INDEX "booking_drafts_expiry_idx"
  ON "booking_drafts" ("expires_at")
  WHERE "status" IN ('COLLECTING', 'AVAILABILITY_CHECKED', 'AWAITING_CONFIRMATION');

CREATE TABLE "booking_source_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "booking_drafts"("id") ON DELETE CASCADE,
  "session_key" text NOT NULL,
  "source_event_id" text NOT NULL,
  "operation" text NOT NULL,
  "result_version" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "booking_source_events_source_nonempty" CHECK (length("source_event_id") BETWEEN 1 AND 300),
  CONSTRAINT "booking_source_events_version_positive" CHECK ("result_version" > 0)
);
CREATE UNIQUE INDEX "booking_source_events_dedupe_uq"
  ON "booking_source_events" ("workspace_id", "session_key", "source_event_id");
CREATE INDEX "booking_source_events_draft_idx"
  ON "booking_source_events" ("draft_id", "created_at");

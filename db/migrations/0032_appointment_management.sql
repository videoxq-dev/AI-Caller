CREATE TABLE "appointment_management_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "session_key" text NOT NULL,
  "channel" "contact_channel" NOT NULL,
  "intent" text NOT NULL CHECK ("intent" IN ('RESCHEDULE', 'CANCEL')),
  "status" text NOT NULL DEFAULT 'COLLECTING'
    CHECK ("status" IN ('COLLECTING', 'AWAITING_CONFIRMATION', 'EXECUTING', 'COMPLETED', 'ABANDONED', 'FAILED')),
  "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "original_starts_at" timestamptz,
  "original_ends_at" timestamptz,
  "original_updated_at" timestamptz,
  "proposed_starts_at" timestamptz,
  "proposed_ends_at" timestamptz,
  "local_date" text,
  "local_time" text,
  "timezone" text,
  "source_event_id" text,
  "preview_delivered_at" timestamptz,
  "preview_delivery_reference" text,
  "expires_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "appointment_management_one_active_session_uq"
  ON "appointment_management_requests" ("workspace_id", "session_key")
  WHERE "status" IN ('COLLECTING', 'AWAITING_CONFIRMATION', 'EXECUTING');
CREATE INDEX "appointment_management_owner_idx"
  ON "appointment_management_requests" ("workspace_id", "contact_id", "conversation_id", "updated_at");
CREATE INDEX "appointment_management_expiry_idx"
  ON "appointment_management_requests" ("status", "expires_at");

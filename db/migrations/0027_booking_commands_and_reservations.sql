-- Durable single-owner booking commands and capacity claims.
-- A provider timeout is not a failed booking. RECONCILING reservations are not
-- released on worker lease expiry.
CREATE TABLE "booking_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "booking_drafts"("id") ON DELETE CASCADE,
  "draft_version" integer NOT NULL CHECK ("draft_version" > 0),
  "preview_id" uuid NOT NULL REFERENCES "booking_previews"("id"),
  "offer_id" uuid NOT NULL REFERENCES "booking_offers"("id"),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN (
    'PENDING','COMMITTING','RECONCILING','CONFIRMED','FAILED'
  )),
  "snapshot" jsonb NOT NULL,
  "provider" text NOT NULL,
  "integration_id" uuid REFERENCES "integrations"("id") ON DELETE SET NULL,
  "provider_event_key" text,
  "provider_external_id" text,
  "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "lease_owner" uuid,
  "lease_expires_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "last_error_code" text,
  "next_attempt_at" timestamptz,
  "provider_attempted_at" timestamptz,
  "confirmed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "booking_commands_preview_uq" ON "booking_commands" ("preview_id");
CREATE UNIQUE INDEX "booking_commands_draft_version_uq" ON "booking_commands" ("draft_id","draft_version");
CREATE UNIQUE INDEX "booking_commands_provider_key_uq"
  ON "booking_commands" ("integration_id","provider_event_key")
  WHERE "provider_event_key" IS NOT NULL;
CREATE INDEX "booking_commands_recovery_idx"
  ON "booking_commands" ("state","next_attempt_at","created_at");

CREATE TABLE "booking_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "command_id" uuid NOT NULL REFERENCES "booking_commands"("id") ON DELETE CASCADE,
  "resource_key" text NOT NULL DEFAULT 'workspace',
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "timezone" text NOT NULL,
  "state" text NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','RELEASED')),
  "released_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "booking_reservations_interval_positive" CHECK ("ends_at" > "starts_at")
);
CREATE UNIQUE INDEX "booking_reservations_command_uq" ON "booking_reservations" ("command_id");
CREATE INDEX "booking_reservations_capacity_idx"
  ON "booking_reservations" ("workspace_id","resource_key","starts_at","ends_at")
  WHERE "state" = 'ACTIVE';

ALTER TABLE "appointments"
  ADD COLUMN "booking_command_id" uuid REFERENCES "booking_commands"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "appointments_booking_command_uq"
  ON "appointments" ("booking_command_id")
  WHERE "booking_command_id" IS NOT NULL;
ALTER TABLE "booking_drafts"
  ADD COLUMN "booking_command_id" uuid REFERENCES "booking_commands"("id") ON DELETE SET NULL;

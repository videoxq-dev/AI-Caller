CREATE TABLE IF NOT EXISTS "hosted_phone_numbers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" text DEFAULT 'telnyx' NOT NULL,
  "provider_number_id" text,
  "provider_order_id" text,
  "phone_number" text NOT NULL,
  "country_code" text NOT NULL,
  "administrative_area" text,
  "locality" text,
  "number_type" text DEFAULT 'local' NOT NULL,
  "status" text DEFAULT 'PROVISIONING' NOT NULL,
  "provider_monthly_cost_micros" bigint NOT NULL,
  "provider_upfront_cost_micros" bigint DEFAULT 0 NOT NULL,
  "monthly_credits" integer NOT NULL,
  "purchase_credits" integer NOT NULL,
  "voice_connection_id" text,
  "messaging_profile_id" text,
  "current_period_start" timestamptz,
  "current_period_end" timestamptz,
  "next_billing_at" timestamptz,
  "grace_ends_at" timestamptz,
  "failure_reason" text,
  "released_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "hosted_phone_numbers_workspace_status_idx"
  ON "hosted_phone_numbers" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "hosted_phone_numbers_due_idx"
  ON "hosted_phone_numbers" ("status", "next_billing_at");
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_phone_numbers_provider_id_uq"
  ON "hosted_phone_numbers" ("provider", "provider_number_id")
  WHERE "provider_number_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_phone_numbers_active_number_uq"
  ON "hosted_phone_numbers" ("phone_number")
  WHERE "released_at" IS NULL;

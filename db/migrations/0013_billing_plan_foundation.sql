CREATE TABLE IF NOT EXISTS "plans" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "description" text,
  "active" boolean DEFAULT true NOT NULL,
  "sub_user_limit" integer NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "workspace_plans" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "plan_id" text NOT NULL REFERENCES "plans"("id"),
  "source" text DEFAULT 'SYSTEM' NOT NULL,
  "assigned_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "workspace_plans_plan_idx" ON "workspace_plans" ("plan_id");

CREATE TABLE IF NOT EXISTS "hosted_api_rate_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "capability" capability_type NOT NULL,
  "provider" text NOT NULL,
  "model" text DEFAULT '' NOT NULL,
  "unit" text NOT NULL,
  "cost_micros" bigint NOT NULL,
  "units_per_cost" integer NOT NULL,
  "target_margin_bps" integer DEFAULT 5500 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "effective_from" timestamptz DEFAULT now() NOT NULL,
  "effective_to" timestamptz,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_api_rate_cards_version_uq"
  ON "hosted_api_rate_cards" ("capability", "provider", "model", "unit", "effective_from");
CREATE INDEX IF NOT EXISTS "hosted_api_rate_cards_lookup_idx"
  ON "hosted_api_rate_cards" ("capability", "provider", "model", "enabled", "effective_from");

CREATE TABLE IF NOT EXISTS "credit_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "amount" integer NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "actual_amount" integer,
  "reference_type" text NOT NULL,
  "reference_id" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "settled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "credit_reservations_reference_uq"
  ON "credit_reservations" ("workspace_id", "reference_type", "reference_id");
CREATE INDEX IF NOT EXISTS "credit_reservations_expiry_idx"
  ON "credit_reservations" ("status", "expires_at");

ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "provider_cost_micros" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "billed_units" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "pricing_details" jsonb DEFAULT '{}'::jsonb NOT NULL;

INSERT INTO "plans" ("id", "name", "description", "sub_user_limit", "metadata")
VALUES
  ('PERSONAL', 'Personal', 'Full product access for one workspace owner.', 0, '{"allCoreFeatures":true}'::jsonb),
  ('GROWTH', 'Growth', 'Full product access with up to three sub-users.', 3, '{"allCoreFeatures":true}'::jsonb)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "sub_user_limit" = EXCLUDED."sub_user_limit",
  "metadata" = EXCLUDED."metadata",
  "updated_at" = now();

INSERT INTO "workspace_plans" ("workspace_id", "plan_id", "source")
SELECT
  w."id",
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m."workspace_id" = w."id" AND m."role" <> 'OWNER'
    ) OR EXISTS (
      SELECT 1 FROM "workspace_invitations" wi
      WHERE wi."workspace_id" = w."id"
        AND wi."status" = 'PENDING'
        AND wi."expires_at" > now()
    )
    THEN 'GROWTH'
    ELSE 'PERSONAL'
  END,
  'MIGRATION'
FROM "workspaces" w
ON CONFLICT ("workspace_id") DO NOTHING;

INSERT INTO "hosted_api_rate_cards"
  ("capability", "provider", "model", "unit", "cost_micros", "units_per_cost", "target_margin_bps", "metadata")
VALUES
  ('AI_TEXT', 'openai', 'gpt-5.6-luna', 'AI_INPUT_TOKEN', 200000, 1000000, 5500, '{"currency":"USD"}'::jsonb),
  ('AI_TEXT', 'openai', 'gpt-5.6-luna', 'AI_CACHED_INPUT_TOKEN', 20000, 1000000, 5500, '{"currency":"USD"}'::jsonb),
  ('AI_TEXT', 'openai', 'gpt-5.6-luna', 'AI_OUTPUT_TOKEN', 1200000, 1000000, 5500, '{"currency":"USD"}'::jsonb),
  ('SMS', 'telnyx', '', 'SMS_SEGMENT', 10000, 1, 5500, '{"currency":"USD","market":"US","basis":"conservative_us_outbound_base_plus_max_carrier_fee"}'::jsonb);

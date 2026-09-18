CREATE TABLE IF NOT EXISTS "credit_packs" (
  "code" text PRIMARY KEY,
  "name" text NOT NULL,
  "credits" integer NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "credit_topups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "pack_code" text NOT NULL REFERENCES "credit_packs"("code"),
  "credits" integer NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" text NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "stripe_checkout_session_id" text,
  "stripe_payment_intent_id" text,
  "stripe_charge_id" text,
  "stripe_dispute_id" text,
  "refunded_amount_cents" integer DEFAULT 0 NOT NULL,
  "disputed_amount_cents" integer DEFAULT 0 NOT NULL,
  "reversed_credits" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "paid_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "credit_topups_workspace_created_idx"
  ON "credit_topups" ("workspace_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "credit_topups_stripe_session_uq"
  ON "credit_topups" ("stripe_checkout_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "credit_topups_stripe_payment_intent_uq"
  ON "credit_topups" ("stripe_payment_intent_id");
CREATE INDEX IF NOT EXISTS "credit_topups_stripe_charge_idx"
  ON "credit_topups" ("stripe_charge_id");

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "stripe_event_id" text PRIMARY KEY,
  "event_type" text NOT NULL,
  "status" text DEFAULT 'RECEIVED' NOT NULL,
  "error" text,
  "received_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz
);

INSERT INTO "credit_packs" ("code", "name", "credits", "amount_cents", "currency", "sort_order")
VALUES
  ('CREDITS_10000', '10,000 credits', 10000, 1000, 'usd', 10),
  ('CREDITS_25000', '25,000 credits', 25000, 2500, 'usd', 20),
  ('CREDITS_50000', '50,000 credits', 50000, 5000, 'usd', 30),
  ('CREDITS_100000', '100,000 credits', 100000, 10000, 'usd', 40)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "credits" = EXCLUDED."credits",
  "amount_cents" = EXCLUDED."amount_cents",
  "currency" = EXCLUDED."currency",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = now();

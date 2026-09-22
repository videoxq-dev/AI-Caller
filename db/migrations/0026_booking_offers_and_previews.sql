-- Version-scoped availability offers and immutable customer previews.
-- Additive only: the legacy pending action executor remains unchanged.
CREATE TABLE "booking_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "booking_drafts"("id") ON DELETE CASCADE,
  "draft_version" integer NOT NULL CHECK ("draft_version" > 0),
  "search_id" uuid NOT NULL,
  "service_id" uuid NOT NULL REFERENCES "services"("id"),
  "duration_minutes" integer NOT NULL CHECK ("duration_minutes" BETWEEN 5 AND 1440),
  "provider" text NOT NULL,
  "integration_id" uuid REFERENCES "integrations"("id") ON DELETE SET NULL,
  "binding_fingerprint" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "timezone" text NOT NULL,
  "checked_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "booking_offers_interval_positive" CHECK ("ends_at" > "starts_at")
);
CREATE INDEX "booking_offers_search_idx" ON "booking_offers" ("workspace_id","draft_id","search_id","starts_at");
CREATE INDEX "booking_offers_expiry_idx" ON "booking_offers" ("expires_at");

CREATE TABLE "booking_previews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "booking_drafts"("id") ON DELETE CASCADE,
  "draft_version" integer NOT NULL CHECK ("draft_version" > 0),
  "offer_id" uuid NOT NULL REFERENCES "booking_offers"("id"),
  "content" jsonb NOT NULL,
  "question_type" text NOT NULL DEFAULT 'BOOK_APPOINTMENT'
    CHECK ("question_type" = 'BOOK_APPOINTMENT'),
  "delivery_channel" text,
  "delivery_reference" text,
  "delivered_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "booking_previews_delivery_pair" CHECK (
    ("delivery_channel" IS NULL AND "delivery_reference" IS NULL AND "delivered_at" IS NULL)
    OR ("delivery_channel" IS NOT NULL AND "delivery_reference" IS NOT NULL AND "delivered_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "booking_previews_draft_version_uq"
  ON "booking_previews" ("draft_id","draft_version");
CREATE UNIQUE INDEX "booking_previews_offer_uq" ON "booking_previews" ("offer_id");

ALTER TABLE "booking_drafts"
  ADD COLUMN "current_search_id" uuid,
  ADD COLUMN "selected_offer_id" uuid REFERENCES "booking_offers"("id") ON DELETE SET NULL,
  ADD COLUMN "current_preview_id" uuid REFERENCES "booking_previews"("id") ON DELETE SET NULL;

-- Phase 6B: channel-specific WhatsApp preference state and append-only evidence.
-- Existing SMS consent cannot be imported as WhatsApp permission.
CREATE TABLE "whatsapp_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts" ("id") ON DELETE CASCADE,
  "wa_id" text NOT NULL,
  "category" text NOT NULL CHECK ("category" IN ('UTILITY','MARKETING')),
  "status" text NOT NULL CHECK ("status" IN ('OPTED_IN','OPTED_OUT')),
  "source" text NOT NULL,
  "source_reference" text,
  "consent_statement" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "whatsapp_consents_contact_wa_category_uq" UNIQUE
    ("workspace_id", "contact_id", "wa_id", "category")
);
CREATE INDEX "whatsapp_consents_destination_idx"
  ON "whatsapp_consents" ("workspace_id", "wa_id", "category");

CREATE TABLE "whatsapp_consent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts" ("id") ON DELETE CASCADE,
  "wa_id" text NOT NULL,
  "category" text NOT NULL CHECK ("category" IN ('UTILITY','MARKETING')),
  "status" text NOT NULL CHECK ("status" IN ('OPTED_IN','OPTED_OUT')),
  "source" text NOT NULL,
  "source_reference" text,
  "consent_statement" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "whatsapp_consent_events_contact_idx"
  ON "whatsapp_consent_events" ("workspace_id", "contact_id", "occurred_at");

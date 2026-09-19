CREATE TABLE IF NOT EXISTS sms_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  category text NOT NULL CHECK (category IN ('TRANSACTIONAL', 'MARKETING')),
  status text NOT NULL CHECK (status IN ('OPTED_IN', 'OPTED_OUT')),
  source text NOT NULL,
  source_reference text,
  consent_statement text,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_consents_contact_phone_category_uq UNIQUE (workspace_id, contact_id, phone_number, category)
);
CREATE INDEX IF NOT EXISTS sms_consents_phone_idx ON sms_consents (workspace_id, phone_number);
CREATE TABLE IF NOT EXISTS sms_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  category text NOT NULL CHECK (category IN ('TRANSACTIONAL', 'MARKETING')),
  status text NOT NULL CHECK (status IN ('OPTED_IN', 'OPTED_OUT')),
  source text NOT NULL,
  source_reference text,
  consent_statement text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_consent_events_contact_idx ON sms_consent_events (workspace_id, contact_id, occurred_at);
CREATE TABLE IF NOT EXISTS sms_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  phone_number_id uuid NOT NULL REFERENCES hosted_phone_numbers(id) ON DELETE CASCADE,
  number_type text NOT NULL CHECK (number_type IN ('local', 'toll_free')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTING','PENDING','READY','REJECTED')),
  carrier_brand_id text,
  carrier_campaign_id text,
  carrier_verification_id text,
  carrier_status text,
  rejection_reason text,
  draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_policy jsonb,
  submitted_at timestamptz,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_registrations_number_uq UNIQUE (phone_number_id)
);
CREATE INDEX IF NOT EXISTS sms_registrations_reconcile_idx ON sms_registrations (status, checked_at);

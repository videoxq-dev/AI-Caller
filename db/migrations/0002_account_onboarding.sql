DO $$ BEGIN
  CREATE TYPE license_source AS ENUM ('JVZOO', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE license_status AS ENUM ('ACTIVE', 'REFUNDED', 'CHARGEBACK', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE ai_agent_status AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE credit_ledger_type AS ENUM ('GRANT', 'PURCHASE', 'DEBIT', 'REFUND', 'ADJUSTMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE commerce_event_status AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source license_source NOT NULL,
  external_purchase_id text NOT NULL,
  product_code text NOT NULL,
  status license_status NOT NULL DEFAULT 'ACTIVE',
  purchased_at timestamptz NOT NULL,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS licenses_source_purchase_product_uq ON licenses(source, external_purchase_id, product_code);
CREATE INDEX IF NOT EXISTS licenses_workspace_idx ON licenses(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_entitlements (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_entitlements_pk PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS business_profiles (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  business_name text NOT NULL,
  industry text,
  website_url text,
  phone text,
  address text,
  city text,
  state text,
  postal_code text,
  country text,
  service_radius text,
  timezone text NOT NULL DEFAULT 'UTC',
  summary text,
  setup_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_hours (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day_of_week integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  enabled boolean NOT NULL DEFAULT false,
  open_time text,
  close_time text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_hours_pk PRIMARY KEY (workspace_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'AI Assistant',
  status ai_agent_status NOT NULL DEFAULT 'DRAFT',
  tone text NOT NULL DEFAULT 'Friendly & professional',
  primary_goal text NOT NULL DEFAULT 'Book appointments',
  when_unsure text NOT NULL DEFAULT 'Escalate to a human',
  advanced_instructions text,
  opening_message text,
  escalation_message text,
  behavior_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_workspace_uq ON ai_agents(workspace_id);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_text text,
  duration_minutes integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS services_workspace_idx ON services(workspace_id);

CREATE TABLE IF NOT EXISTS faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS faqs_workspace_idx ON faqs(workspace_id);

CREATE TABLE IF NOT EXISTS policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policies_workspace_idx ON policies(workspace_id);

CREATE TABLE IF NOT EXISTS setup_progress (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  business_completed_at timestamptz,
  ai_completed_at timestamptz,
  communication_completed_at timestamptz,
  calendar_completed_at timestamptz,
  test_completed_at timestamptz,
  live_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_wallets (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type credit_ledger_type NOT NULL,
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  reason text NOT NULL,
  reference_type text,
  reference_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_workspace_idx ON credit_ledger(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_reference_uq ON credit_ledger(workspace_id, type, reference_type, reference_id);

CREATE TABLE IF NOT EXISTS commerce_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source license_source NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  status commerce_event_status NOT NULL DEFAULT 'RECEIVED',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_events_source_external_uq ON commerce_events(source, external_event_id);

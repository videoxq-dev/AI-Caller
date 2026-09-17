DO $$ BEGIN
  CREATE TYPE integration_category AS ENUM ('AI', 'COMMUNICATION', 'WHATSAPP', 'CALENDAR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE integration_mode AS ENUM ('HOSTED', 'BYOP');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE integration_status AS ENUM ('CONNECTED', 'ERROR', 'DISCONNECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE capability_type AS ENUM ('AI_TEXT', 'SMS', 'VOICE', 'WHATSAPP', 'CALENDAR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category integration_category NOT NULL,
  provider text NOT NULL,
  mode integration_mode NOT NULL DEFAULT 'BYOP',
  status integration_status NOT NULL DEFAULT 'DISCONNECTED',
  encrypted_credentials jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS integrations_workspace_provider_uq ON integrations(workspace_id, provider);
CREATE INDEX IF NOT EXISTS integrations_workspace_category_idx ON integrations(workspace_id, category);

CREATE TABLE IF NOT EXISTS capability_bindings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capability capability_type NOT NULL,
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  mode integration_mode NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capability_bindings_pk PRIMARY KEY (workspace_id, capability)
);

CREATE TABLE IF NOT EXISTS communication_setup_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar_setup_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

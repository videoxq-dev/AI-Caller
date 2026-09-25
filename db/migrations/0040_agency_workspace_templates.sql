-- Immutable Agency-owned configuration snapshots. A template is not a workspace
-- and contains no operational ownership, credentials, contacts or billing data.
CREATE TABLE agency_workspace_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchaser_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agency_workspace_templates_owner_idx
  ON agency_workspace_templates(purchaser_user_id, status, created_at DESC);

CREATE TABLE agency_workspace_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES agency_workspace_templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template_id, version)
);
CREATE INDEX agency_workspace_template_versions_template_idx
  ON agency_workspace_template_versions(template_id, version DESC);

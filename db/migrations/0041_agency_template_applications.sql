-- Track exact template version used for each independently provisioned client.
-- An idempotency key can create at most one workspace for a purchaser.
CREATE TABLE agency_workspace_template_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchaser_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE UNIQUE,
  template_id uuid NOT NULL REFERENCES agency_workspace_templates(id),
  template_version_id uuid NOT NULL REFERENCES agency_workspace_template_versions(id),
  template_version integer NOT NULL CHECK (template_version > 0),
  requested_name text NOT NULL,
  request_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(purchaser_user_id, request_key)
);
CREATE INDEX agency_workspace_template_applications_owner_idx
  ON agency_workspace_template_applications(purchaser_user_id, created_at DESC);

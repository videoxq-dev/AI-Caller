-- A manual setup attestation is specific to a cloned client's current
-- configuration. It is not a carrier-delivery or provider test result.
CREATE TABLE agency_template_activation_reviews (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  reviewer_user_id text NOT NULL REFERENCES "user"(id),
  configuration_hash text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

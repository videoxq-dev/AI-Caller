-- Preserve the origin of a workspace independently of future Agency refunds,
-- provider-supplied purchased_at, and later purchaser upgrades. Historical
-- ADDITIONAL records retain LEGACY provenance until reconciled: timestamps do
-- not prove whether they started as Unlimited or Agency businesses.
ALTER TABLE workspace_commercial_owners
  ADD COLUMN provisioning_source text NOT NULL DEFAULT 'LEGACY';
ALTER TABLE workspace_commercial_owners
  ADD CONSTRAINT workspace_commercial_owners_provisioning_source_chk
  CHECK (provisioning_source IN ('PRIMARY', 'UNLIMITED', 'AGENCY', 'LEGACY'));
UPDATE workspace_commercial_owners
SET provisioning_source = 'PRIMARY'
WHERE kind = 'PRIMARY';
UPDATE workspace_commercial_owners AS owner
SET provisioning_source = 'AGENCY'
WHERE owner.kind = 'ADDITIONAL'
  AND EXISTS (
    SELECT 1 FROM agency_workspace_template_applications AS application
    WHERE application.workspace_id = owner.workspace_id
  );

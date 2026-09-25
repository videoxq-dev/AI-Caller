-- F12-B: preserve commercial Agency-client identity across refund and upgrade.
-- Legacy extra businesses are classified using the original business creation time,
-- NOT workspace_commercial_owners.created_at: migration 0038 backfilled that
-- column at migration time, so it is not reliable historical provenance.
-- ambiguous historical/manual records require an explicit data reconciliation.
ALTER TABLE workspace_commercial_owners
  ADD COLUMN agency_client boolean NOT NULL DEFAULT false;

UPDATE workspace_commercial_owners AS commercial
SET agency_client = true,
    updated_at = now()
FROM workspaces AS business
WHERE business.id = commercial.workspace_id
  AND commercial.kind = 'ADDITIONAL'
  AND EXISTS (
    SELECT 1 FROM licenses AS agency
    WHERE agency.purchaser_user_id = commercial.purchaser_user_id
      AND agency.product_code IN ('AGENCY_50', 'AGENCY_100')
      AND agency.purchased_at <= business.created_at
  );

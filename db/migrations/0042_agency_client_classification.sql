-- F12-B: preserve commercial Agency-client identity across refund and upgrade.
-- Legacy extra businesses are classified by existing purchase chronology;
-- ambiguous historical/manual records require an explicit data reconciliation.
ALTER TABLE workspace_commercial_owners
  ADD COLUMN agency_client boolean NOT NULL DEFAULT false;

UPDATE workspace_commercial_owners AS commercial
SET agency_client = true,
    updated_at = now()
WHERE commercial.kind = 'ADDITIONAL'
  AND EXISTS (
    SELECT 1 FROM licenses AS agency
    WHERE agency.purchaser_user_id = commercial.purchaser_user_id
      AND agency.product_code IN ('AGENCY_50', 'AGENCY_100')
      AND agency.purchased_at <= commercial.created_at
  );

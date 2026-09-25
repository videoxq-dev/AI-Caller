-- F12-B: persist whether an additional business was provisioned as an Agency
-- client. This flag is not revoked when Agency purchases are refunded:
-- previously granted Core-only client feature boundaries remain intact.
ALTER TABLE workspace_commercial_owners
  ADD COLUMN agency_client boolean NOT NULL DEFAULT false;

-- Existing Agency clients were provisioned after their Agency purchase.
-- Preserve a separately purchased Unlimited second business created before
-- Agency acquisition. Ambiguous manual/legacy timelines require explicit
-- purchaser-reviewed reconciliation rather than guessing from OWNER count.
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

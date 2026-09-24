-- Identify the purchaser separately from the licensed business workspace.
-- Existing licenses are backfilled only when a workspace has exactly one OWNER;
-- ambiguous/no-owner historical licenses stay unassigned for explicit reconciliation.
ALTER TABLE "licenses"
  ADD COLUMN IF NOT EXISTS "purchaser_user_id" text REFERENCES "user"("id") ON DELETE SET NULL;

UPDATE "licenses" l
SET "purchaser_user_id" = sole_owner."user_id"
FROM (
  SELECT "workspace_id", min("user_id") AS "user_id"
  FROM "memberships"
  WHERE "role" = 'OWNER'
  GROUP BY "workspace_id"
  HAVING count(*) = 1
) sole_owner
WHERE l."workspace_id" = sole_owner."workspace_id"
  AND l."purchaser_user_id" IS NULL;

CREATE INDEX IF NOT EXISTS "licenses_purchaser_status_idx"
  ON "licenses" ("purchaser_user_id", "status", "product_code");

-- Separate commercial workspace ownership from operational workspace roles.
-- Backfill only workspaces with exactly one operational OWNER so ambiguous
-- historical co-owned workspaces remain explicit reconciliation cases.
CREATE TABLE IF NOT EXISTS "workspace_commercial_owners" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "purchaser_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('PRIMARY', 'ADDITIONAL')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

WITH sole_owner_workspaces AS (
  SELECT
    m."workspace_id",
    min(m."user_id") AS "user_id",
    min(m."created_at") AS "membership_created_at"
  FROM "memberships" m
  WHERE m."role" = 'OWNER'
  GROUP BY m."workspace_id"
  HAVING count(*) = 1
),
ranked AS (
  SELECT
    s."workspace_id",
    s."user_id",
    CASE
      WHEN row_number() OVER (
        PARTITION BY s."user_id"
        ORDER BY s."membership_created_at", s."workspace_id"
      ) = 1 THEN 'PRIMARY'
      ELSE 'ADDITIONAL'
    END AS "kind"
  FROM sole_owner_workspaces s
)
INSERT INTO "workspace_commercial_owners" (
  "workspace_id",
  "purchaser_user_id",
  "kind"
)
SELECT
  r."workspace_id",
  r."user_id",
  r."kind"
FROM ranked r
ON CONFLICT ("workspace_id") DO NOTHING;

CREATE INDEX IF NOT EXISTS "workspace_commercial_owners_purchaser_idx"
  ON "workspace_commercial_owners" ("purchaser_user_id", "kind", "created_at");

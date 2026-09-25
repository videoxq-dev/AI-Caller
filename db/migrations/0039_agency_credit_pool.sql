-- Agency-funded credits are owned by the commercial purchaser, not by the
-- Agency's original business or any of its client workspaces.
CREATE TABLE IF NOT EXISTS agency_credit_pools (
  purchaser_user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agency_credit_pool_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchaser_user_id text NOT NULL REFERENCES agency_credit_pools(purchaser_user_id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('PURCHASE', 'ALLOCATION', 'ADJUSTMENT')),
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  reason text NOT NULL,
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agency_credit_pool_ledger_reference_uq UNIQUE (purchaser_user_id, type, reference_type, reference_id)
);
CREATE INDEX IF NOT EXISTS agency_credit_pool_ledger_created_idx
  ON agency_credit_pool_ledger (purchaser_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agency_credit_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchaser_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id text NOT NULL REFERENCES "user"(id),
  idempotency_key uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agency_credit_allocations_idempotency_uq UNIQUE (purchaser_user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS agency_credit_allocations_target_idx
  ON agency_credit_allocations (workspace_id, created_at DESC);

ALTER TABLE credit_topups ADD COLUMN IF NOT EXISTS funding_destination text NOT NULL DEFAULT 'WORKSPACE';
ALTER TABLE credit_topups ADD COLUMN IF NOT EXISTS agency_purchaser_user_id text REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE credit_topups ADD CONSTRAINT credit_topups_funding_destination_check
  CHECK (
    (funding_destination = 'WORKSPACE' AND agency_purchaser_user_id IS NULL)
    OR (funding_destination = 'AGENCY_POOL' AND agency_purchaser_user_id IS NOT NULL)
  );

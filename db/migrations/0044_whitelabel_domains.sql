-- F12-D1: purchaser-owned custom-domain registry and durable lifecycle state.
CREATE TABLE whitelabel_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES whitelabel_brands(id) ON DELETE CASCADE,
  purchaser_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'DRAFT','AWAITING_DNS','VERIFIED','ROUTE_PROVISIONING','CERT_PENDING',
    'CERT_READY','ACTIVE','DISABLING','DISABLED','REVOKED','DNS_MISMATCH'
  )),
  verification_token_encrypted jsonb NOT NULL,
  a_verified_at timestamptz,
  txt_verified_at timestamptz,
  dns_verified_at timestamptz,
  route_id text,
  route_provisioned_at timestamptz,
  certificate_status text NOT NULL DEFAULT 'NOT_REQUESTED'
    CHECK (certificate_status IN ('NOT_REQUESTED','PENDING','READY','FAILED')),
  certificate_ready_at timestamptz,
  certificate_expires_at timestamptz,
  last_checked_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE UNIQUE INDEX whitelabel_domains_hostname_active_uq
  ON whitelabel_domains (hostname)
  WHERE status <> 'DISABLED';

CREATE UNIQUE INDEX whitelabel_domains_brand_active_uq
  ON whitelabel_domains (brand_id)
  WHERE status <> 'DISABLED';

CREATE INDEX whitelabel_domains_purchaser_idx
  ON whitelabel_domains (purchaser_user_id, created_at DESC);
CREATE INDEX whitelabel_domains_status_idx
  ON whitelabel_domains (status, last_checked_at);

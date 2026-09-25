-- F12-C: purchaser-owned Whitelabel brand drafts, immutable publications, and brand media metadata.
CREATE TABLE whitelabel_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchaser_user_id text NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  published_version integer CHECK (published_version IS NULL OR published_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE whitelabel_brand_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES whitelabel_brands(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  published_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, version)
);

CREATE INDEX whitelabel_brand_versions_brand_idx
  ON whitelabel_brand_versions (brand_id, version DESC);

CREATE TABLE whitelabel_brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES whitelabel_brands(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('LOGO', 'ICON', 'FAVICON')),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  created_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE INDEX whitelabel_brand_assets_brand_idx
  ON whitelabel_brand_assets (brand_id, kind, created_at DESC);

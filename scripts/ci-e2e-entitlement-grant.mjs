import pg from "pg";

const { Client } = pg;
const mode = process.argv[2];
const emailPrefix = process.argv[3] ?? "";
const productCode = process.argv[4] ?? "";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!["install", "remove"].includes(mode)) {
  throw new Error("Usage: node scripts/ci-e2e-entitlement-grant.mjs <install|remove> [email-prefix] [product-code]");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  if (mode === "remove") {
    await client.query(`
      DO $guard$
      BEGIN
        IF to_regclass('public.memberships') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS ci_e2e_entitlement_grant ON memberships;
        END IF;
      END
      $guard$;
      DROP FUNCTION IF EXISTS ci_e2e_entitlement_grant();
    `);
    process.exitCode = 0;
  } else {
    if (!/^[a-z0-9-]+$/i.test(emailPrefix)) throw new Error("Invalid email prefix");
    const allowedProducts = new Set(["CORE", "UNLIMITED", "PERFORMANCE", "AGENCY_50", "AGENCY_100", "WHITELABEL"]);
    if (!allowedProducts.has(productCode)) throw new Error("Unsupported product code");

    const emailPattern = `${emailPrefix}%@example.com`;
    const purchasePrefix = `ci-e2e-${productCode.toLowerCase()}-`;

    await client.query(`
      CREATE OR REPLACE FUNCTION ci_e2e_entitlement_grant()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        owner_email text;
      BEGIN
        IF NEW.role = 'OWNER' THEN
          SELECT email INTO owner_email FROM "user" WHERE id = NEW.user_id;
          IF owner_email LIKE '${emailPattern}' THEN
            INSERT INTO licenses (
              workspace_id,
              purchaser_user_id,
              source,
              external_purchase_id,
              product_code,
              status,
              purchased_at
            )
            VALUES (
              NEW.workspace_id,
              NEW.user_id,
              'MANUAL',
              '${purchasePrefix}' || NEW.workspace_id::text,
              '${productCode}',
              'ACTIVE',
              now()
            )
            ON CONFLICT DO NOTHING;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS ci_e2e_entitlement_grant ON memberships;
      CREATE TRIGGER ci_e2e_entitlement_grant
      AFTER INSERT ON memberships
      FOR EACH ROW
      EXECUTE FUNCTION ci_e2e_entitlement_grant();
    `);
  }
} finally {
  await client.end();
}

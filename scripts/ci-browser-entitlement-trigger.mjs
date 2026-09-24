import pg from "pg";

const { Pool } = pg;
const [action, emailPrefix, productCode] = process.argv.slice(2);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!["install", "remove"].includes(action)) {
  throw new Error("Usage: node scripts/ci-browser-entitlement-trigger.mjs <install|remove> <email-prefix> <product-code>");
}
if (!/^[a-z0-9-]+$/i.test(emailPrefix ?? "")) throw new Error("Invalid email prefix.");
if (!/^[A-Z0-9_]+$/.test(productCode ?? "")) throw new Error("Invalid product code.");

const sqlLiteral = value => `'${value.replaceAll("'", "''")}'`;
const emailPattern = sqlLiteral(`${emailPrefix}%`);
const product = sqlLiteral(productCode);
const triggerName = "ci_browser_entitlement_grant";
const functionName = "ci_browser_entitlement_grant_fn";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON memberships`);
  await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);

  if (action === "install") {
    await pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        IF NEW.role = 'OWNER' AND EXISTS (
          SELECT 1
          FROM "user"
          WHERE id = NEW.user_id
            AND email LIKE ${emailPattern}
        ) THEN
          INSERT INTO licenses (
            workspace_id,
            purchaser_user_id,
            source,
            external_purchase_id,
            product_code,
            status,
            purchased_at
          ) VALUES (
            NEW.workspace_id,
            NEW.user_id,
            'MANUAL',
            'ci-browser-' || NEW.workspace_id::text || '-' || ${product},
            ${product},
            'ACTIVE',
            now()
          )
          ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON memberships
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `);
  }
} finally {
  await pool.end();
}

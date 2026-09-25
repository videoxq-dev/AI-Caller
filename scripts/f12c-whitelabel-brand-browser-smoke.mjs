import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";
import sharp from "sharp";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const outputDir = path.join(process.cwd(), "artifacts", "f12c-whitelabel-brand");
await mkdir(outputDir, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const failures = [];
page.on("pageerror", error => failures.push(`pageerror: ${error.message}`));
page.on("response", response => {
  if (response.status() >= 500) failures.push(`HTTP ${response.status()} ${response.url()}`);
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function noOverflow(label) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(size.scrollWidth - size.width <= 2, `${label} has horizontal overflow: ${JSON.stringify(size)}`);
}

const stamp = Date.now();
const email = `f12c-brand-${stamp}@example.com`;
const password = "F12cBrandPass123!";

async function grant(userId, workspaceId, code) {
  await pool.query(
    `INSERT INTO licenses
      (workspace_id, purchaser_user_id, source, external_purchase_id, product_code, status, purchased_at)
     VALUES ($1, $2, 'MANUAL', $3, $4, 'ACTIVE', now())`,
    [workspaceId, userId, `f12c-${code}-${stamp}`, code],
  );
}

try {
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "F12C Agency", email, password },
  });
  assert(signup.ok(), `Purchaser signup failed: ${await signup.text()}`);
  const owner = await pool.query(
    `SELECT u.id AS user_id, m.workspace_id FROM "user" u
      JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'`,
    [email],
  );
  assert(owner.rowCount === 1, "Expected purchaser original workspace.");
  const { user_id: userId, workspace_id: originalId } = owner.rows[0];
  await grant(userId, originalId, "CORE");
  await grant(userId, originalId, "AGENCY_50");
  await grant(userId, originalId, "WHITELABEL");

  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Whitelabel" }).waitFor();
  assert(await page.locator(".appBrand").getByText("AI Caller", { exact: true }).count() === 1,
    "Canonical purchaser navigation was rebranded.");

  await page.getByRole("link", { name: "Whitelabel" }).click();
  await page.getByRole("heading", { name: "Whitelabel", exact: true }).waitFor();
  await page.getByLabel("Brand name").fill("Stratos Assist");
  await page.getByLabel("Tagline").fill("Never miss another customer");
  await page.getByLabel("Support email").fill("support@stratosassist.com");

  const png = await sharp({
    create: { width: 160, height: 60, channels: 4, background: "#335577" },
  }).png().toBuffer();
  const logoInput = page.locator(".wlAsset").filter({ hasText: "Logo" }).locator('input[type="file"]');
  await logoInput.setInputFiles({ name: "brand.png", mimeType: "image/png", buffer: png });
  await page.getByText(/Logo uploaded/).waitFor();

  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("Draft saved.").waitFor();
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.getByLabel("Brand name").inputValue() === "Stratos Assist", "Saved brand draft did not survive reload.");
  assert(await page.locator(".wlPreviewBrand img").count() === 1, "Optimized draft logo did not render in preview.");

  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByText("Published brand version 1.").waitFor();
  await page.getByText("Published v1").waitFor();

  await page.getByLabel("Brand name").fill("Stratos Assist Two");
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByText("Published brand version 2.").waitFor();
  await page.getByText("Published v2").waitFor();

  const versionOne = page.locator(".wlVersions>div").filter({ hasText: "Version 1" });
  await versionOne.getByRole("button", { name: "Restore" }).click();
  await page.getByText("Restored version 1 as new published version 3.").waitFor();
  assert(await page.getByLabel("Brand name").inputValue() === "Stratos Assist",
    "Restoring a published brand did not restore its draft snapshot.");
  await page.getByText("Published v3").waitFor();

  await noOverflow("F12-C desktop");
  await page.screenshot({ path: path.join(outputDir, "whitelabel-brand-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Whitelabel", exact: true }).waitFor();
  await noOverflow("F12-C mobile");
  await page.screenshot({ path: path.join(outputDir, "whitelabel-brand-mobile.png"), fullPage: true });

  const clientWorkspace = await context.request.put(`${baseUrl}/api/workspaces`, {
    data: { name: "Branded Client" },
  });
  assert(clientWorkspace.status() === 201, `Agency client creation failed: ${await clientWorkspace.text()}`);
  const clientWorkspaceId = (await clientWorkspace.json()).workspace.workspaceId;
  const clientContext = await browser.newContext();
  const clientEmail = `f12c-client-${stamp}@example.com`;
  const clientSignup = await clientContext.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "Delegated Client", email: clientEmail, password },
  });
  assert(clientSignup.ok(), `Client signup failed: ${await clientSignup.text()}`);
  const clientUser = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [clientEmail]);
  await pool.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'OWNER')
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'OWNER'`,
    [clientWorkspaceId, clientUser.rows[0].id],
  );
  const denied = await clientContext.request.get(`${baseUrl}/api/whitelabel/brand`);
  assert(denied.status() === 403, "Delegated client OWNER gained purchaser Whitelabel brand administration.");
  await clientContext.close();

  await pool.query(
    `UPDATE licenses SET status = 'REFUNDED'
     WHERE purchaser_user_id = $1 AND product_code = 'WHITELABEL'`,
    [userId],
  );
  const revoked = await context.request.get(`${baseUrl}/api/whitelabel/brand`);
  assert(revoked.status() === 403, "Refunded Whitelabel purchaser retained brand administration.");
  const preserved = await pool.query(
    `SELECT b.draft, b.published_version,
       (SELECT count(*)::int FROM whitelabel_brand_versions v WHERE v.brand_id = b.id) AS versions
     FROM whitelabel_brands b WHERE b.purchaser_user_id = $1`,
    [userId],
  );
  assert(preserved.rowCount === 1
    && preserved.rows[0].draft.name === "Stratos Assist"
    && preserved.rows[0].published_version === 3
    && preserved.rows[0].versions === 3,
  "Whitelabel refund deleted or rewrote the preserved brand history.");

  assert(failures.length === 0, failures.join("\n"));
  console.log("F12-C browser acceptance passed: purchaser-only editor, optimized logo upload, draft persistence, immutable publish/restore, canonical AI Caller isolation, responsive preview, delegated-client denial and refund preservation.");
} finally {
  await browser.close();
  await pool.end();
}

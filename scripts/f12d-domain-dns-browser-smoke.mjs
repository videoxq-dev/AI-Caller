import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const outputDir = path.join(process.cwd(), "artifacts", "f12d-domain-dns");
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
const email = `f12d-domain-${stamp}@example.com`;
const password = "F12dDomainPass123!";

async function grant(userId, workspaceId, code) {
  await pool.query(
    `INSERT INTO licenses
      (workspace_id, purchaser_user_id, source, external_purchase_id, product_code, status, purchased_at)
     VALUES ($1, $2, 'MANUAL', $3, $4, 'ACTIVE', now())`,
    [workspaceId, userId, `f12d-${code}-${stamp}`, code],
  );
}

try {
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "F12D Agency", email, password },
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

  await page.goto(`${baseUrl}/whitelabel`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Custom domain" }).waitFor();
  assert(await page.locator(".appBrand").getByText("AI Caller", { exact: true }).count() === 1,
    "Canonical purchaser navigation was rebranded.");

  const hostname = `clients-${stamp}.example.com`;
  await page.getByLabel("Client platform domain").fill(hostname);
  await page.getByRole("button", { name: "Connect domain" }).click();
  await page.getByText("Domain reserved. Add the DNS records below, then verify.").waitFor();
  await page.getByText(hostname, { exact: true }).first().waitFor();
  await page.getByText("203.0.113.25", { exact: true }).waitFor();

  const txtRow = page.locator(".wlDnsRecord").filter({ hasText: "TXT" });
  const before = await txtRow.locator("code").nth(1).textContent();
  assert(before?.startsWith("aicaller-verification="), "TXT verification proof was not rendered.");

  await page.getByRole("button", { name: "Rotate TXT proof" }).click();
  await page.getByText("Verification value rotated. Update the TXT record before verifying again.").waitFor();
  const after = await txtRow.locator("code").nth(1).textContent();
  assert(after?.startsWith("aicaller-verification=") && after !== before,
    "Rotating DNS proof did not produce a new verification value.");

  await page.getByRole("button", { name: "Verify DNS" }).click();
  await page.getByText(/Add an A record pointing to 203\.0\.113\.25\./).waitFor({ timeout: 15_000 });
  await page.getByText("DNS A MISSING", { exact: true }).waitFor();
  await noOverflow("F12-D DNS desktop");
  await page.screenshot({ path: path.join(outputDir, "custom-domain-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Custom domain" }).waitFor();
  await noOverflow("F12-D DNS mobile");
  await page.screenshot({ path: path.join(outputDir, "custom-domain-mobile.png"), fullPage: true });

  page.once("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByText("Custom domain disconnected.").waitFor();
  await page.getByLabel("Client platform domain").waitFor();

  assert(failures.length === 0, failures.join("\n"));
  console.log("F12-D DNS browser acceptance passed: domain claim, DNS instructions, proof rotation, queued worker verification, actionable missing-A state, responsive layout, disconnect and canonical AI Caller isolation.");
} finally {
  await browser.close();
  await pool.end();
}

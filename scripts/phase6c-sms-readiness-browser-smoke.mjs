import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const outputDir = path.join(process.cwd(), "artifacts", "phase6c-sms-readiness");
await mkdir(outputDir, { recursive: true });

function assert(value, label) { if (!value) throw new Error(label); }
async function noOverflow(page) {
  const size = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(size.scroll - size.viewport <= 2, "SMS readiness banner overflows the viewport");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("response", response => {
  if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`);
});

try {
  const email = `phase6c-${Date.now()}@example.com`;
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "SMS Readiness Owner", email, password: "Phase6cBrowserPass123!" },
  });
  assert(signup.ok(), `Sign up failed: ${await signup.text()}`);
  const membership = await pool.query(
    `SELECT m.workspace_id FROM memberships m JOIN "user" u ON u.id = m.user_id
     WHERE u.email = $1 AND m.role = 'OWNER' LIMIT 1`, [email],
  );
  const workspaceId = membership.rows[0]?.workspace_id;
  assert(workspaceId, "Owner workspace missing");

  const created = await context.request.post(`${baseUrl}/api/automations/workflows`, {
    data: { starter: "CUSTOMER_BOOKING_CONFIRMATION" },
  });
  assert(created.ok(), `SMS workflow creation failed: ${await created.text()}`);
  const { id } = await created.json();
  await pool.query(`INSERT INTO capability_bindings (workspace_id, capability, mode)
    VALUES ($1, 'SMS', 'HOSTED')
    ON CONFLICT (workspace_id, capability) DO UPDATE SET mode = 'HOSTED', integration_id = NULL`,
  [workspaceId]);
  const added = await pool.query(`INSERT INTO hosted_phone_numbers
     (workspace_id, phone_number, country_code, number_type, status, messaging_readiness,
      provider_monthly_cost_micros, purchase_credits, monthly_credits)
     VALUES ($1, '+12025550200', 'US', 'local', 'ACTIVE', 'NOT_REGISTERED', 1000000, 1, 1)
     RETURNING id`, [workspaceId]);
  const numberId = added.rows[0].id;

  await page.goto(`${baseUrl}/automations/${id}`, { waitUntil: "networkidle" });
  const banner = page.locator(".builderSmsReadiness");
  await banner.getByText(/SMS registration is not approved/).waitFor();
  assert(await banner.getByRole("link", { name: /View SMS setup/ }).count() === 1,
    "Registration setup link is missing");
  const status = await context.request.get(`${baseUrl}/api/automations/sms-readiness`);
  assert(status.ok(), "SMS readiness request failed");
  assert((await status.json()).readiness.status === "REGISTRATION_REQUIRED",
    "Sender authorization incorrectly bypassed business registration");

  await pool.query(`INSERT INTO sms_registrations (workspace_id, phone_number_id, number_type, status)
    VALUES ($1, $2, 'local', 'PENDING')`, [workspaceId, numberId]);
  await pool.query(`UPDATE hosted_phone_numbers SET messaging_readiness = 'PENDING' WHERE id = $1`, [numberId]);
  await page.reload({ waitUntil: "networkidle" });
  await banner.getByText(/registration is under review/).waitFor();

  await pool.query(`UPDATE sms_registrations
    SET status = 'READY', approved_policy = $2::jsonb
    WHERE workspace_id = $1`, [workspaceId,
    JSON.stringify({ categories: ["TRANSACTIONAL"], allowEmbeddedLinks: false,
      description: "Appointment confirmations and reminders" })]);
  await pool.query(`UPDATE hosted_phone_numbers SET messaging_readiness = 'READY' WHERE id = $1`, [numberId]);
  await page.reload({ waitUntil: "networkidle" });
  await banner.getByText(/SMS ready for transactional messages/).waitFor();
  assert(!(await banner.innerText()).includes("marketing"), "Unapproved marketing category displayed as ready");
  await noOverflow(page);
  await page.screenshot({ path: path.join(outputDir, "sms-readiness-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: path.join(outputDir, "sms-readiness-mobile.png"), fullPage: true });
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log("Phase 6C SMS readiness browser acceptance passed: unregistered, in review, approved category, responsive UI.");
} finally {
  await pool.end();
  await context.close();
  await browser.close();
}

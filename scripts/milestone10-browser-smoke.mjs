import { createHmac, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 10 browser verification.");
if (!stripeWebhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required for Milestone 10 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "milestone10-browser");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(context, method, route, data, label, expectedStatus = null) {
  const response = await context.request.fetch(`${baseUrl}${route}`, {
    method,
    data,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (expectedStatus !== null) {
    assert(response.status() === expectedStatus, `${label} expected ${expectedStatus}, got ${response.status()}: ${text.slice(0, 1000)}`);
  } else if (!response.ok()) {
    throw new Error(`${label} failed with ${response.status()}: ${text.slice(0, 1000)}`);
  }
  return { response, data: parsed, text };
}

async function rawApi(context, method, route, body, headers, label) {
  const response = await context.request.fetch(`${baseUrl}${route}`, {
    method,
    data: body,
    headers,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok()) throw new Error(`${label} failed with ${response.status()}: ${text.slice(0, 1000)}`);
  return parsed;
}

async function waitFor(pool, query, values, predicate, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await pool.query(query, values);
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  const overflow = metrics.scrollWidth - metrics.clientWidth;
  assert(overflow <= 2, `${label} has ${overflow}px of horizontal overflow.`);
}

function stripeSignature(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const browser = await chromium.launch({ headless: true });
const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const userContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const page = await adminContext.newPage();
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const runtimeErrors = [];

page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 500) runtimeErrors.push(`HTTP ${response.status()} ${response.url()}`);
});

const stamp = Date.now();
const adminEmail = `milestone10-admin-${stamp}@example.com`;
const targetEmail = `milestone10-target-${stamp}@example.com`;
const password = "BrowserSmokePass123!";

try {
  await api(adminContext, "POST", "/api/auth/sign-up/email", {
    name: "Milestone Ten Admin",
    email: adminEmail,
    password,
  }, "admin sign up");

  const ownerRow = await waitFor(
    pool,
    `SELECT u.id AS user_id, m.workspace_id
       FROM "user" u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'
      ORDER BY m.created_at LIMIT 1`,
    [adminEmail],
    (rows) => rows.rowCount === 1,
    "admin workspace provisioning",
  );
  const adminUserId = ownerRow.rows[0].user_id;
  const workspaceId = ownerRow.rows[0].workspace_id;

  await pool.query(`UPDATE workspaces SET name = 'Milestone Ten Workspace' WHERE id = $1`, [workspaceId]);
  await pool.query(
    `INSERT INTO platform_admins (user_id, role, active) VALUES ($1, 'ADMIN', true)
     ON CONFLICT (user_id) DO UPDATE SET active = true, updated_at = now()`,
    [adminUserId],
  );
  await pool.query(
    `INSERT INTO workspace_plans (workspace_id, plan_id, source)
     VALUES ($1, 'PERSONAL', 'M10_E2E')
     ON CONFLICT (workspace_id) DO UPDATE SET plan_id = 'PERSONAL', source = 'M10_E2E', updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO credit_wallets (workspace_id, balance) VALUES ($1, 5000)
     ON CONFLICT (workspace_id) DO UPDATE SET balance = 5000, updated_at = now()`,
    [workspaceId],
  );

  const billing = (await api(adminContext, "GET", "/api/billing", undefined, "load billing API")).data;
  assert(billing.plan?.id === "PERSONAL", "Billing API did not return Personal plan.");
  assert(billing.balance === 5000, "Billing API did not return the seeded credit balance.");
  assert(billing.packs?.length === 4, "Billing API did not return four active credit packs.");

  await page.goto(`${baseUrl}/settings/billing`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Billing & Usage", exact: true }).waitFor({ timeout: 10_000 });
  assert(await page.getByText("5,000", { exact: true }).count() > 0, "Live Billing page did not show the credit balance.");
  assert(await page.getByText("Personal", { exact: true }).count() > 0, "Live Billing page did not show Personal.");
  assert(await page.getByText("10,000", { exact: true }).count() > 0, "Credit packs are not visible.");
  await assertNoHorizontalOverflow(page, "Billing desktop");
  await page.screenshot({ path: path.join(outputDir, "billing-desktop.png"), fullPage: true });

  await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByText(/Personal · 0 of 0 sub-user seats used/).waitFor({ timeout: 10_000 });
  assert(await page.getByText("Personal is owner-only. Growth enables up to 3 sub-users.", { exact: true }).isVisible(), "Personal plan owner-only notice is missing.");
  assert(await page.getByPlaceholder("name@business.com").count() === 0, "Personal incorrectly exposes the team invitation form.");

  const topup = await pool.query(
    `INSERT INTO credit_topups
       (workspace_id, created_by_user_id, pack_code, credits, amount_cents, currency, status, stripe_checkout_session_id)
     VALUES ($1, $2, 'CREDITS_10000', 10000, 1000, 'usd', 'CHECKOUT_CREATED', $3)
     RETURNING id`,
    [workspaceId, adminUserId, `cs_m10_${stamp}`],
  );
  const topupId = topup.rows[0].id;
  const sessionId = `cs_m10_${stamp}`;
  const eventId = `evt_m10_${stamp}`;
  const stripeEvent = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        client_reference_id: topupId,
        amount_total: 1000,
        currency: "usd",
        payment_status: "paid",
        payment_intent: `pi_m10_${stamp}`,
        metadata: { workspaceId, topupId, packCode: "CREDITS_10000" },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "checkout.session.completed",
  });
  const signature = stripeSignature(stripeEvent, stripeWebhookSecret);
  const firstWebhook = await rawApi(adminContext, "POST", "/api/webhooks/stripe", stripeEvent, {
    "content-type": "application/json",
    "stripe-signature": signature,
  }, "signed Stripe fulfillment");
  assert(firstWebhook.received === true && firstWebhook.duplicate === false, "Stripe payment was not processed.");

  const duplicateWebhook = await rawApi(adminContext, "POST", "/api/webhooks/stripe", stripeEvent, {
    "content-type": "application/json",
    "stripe-signature": signature,
  }, "duplicate Stripe fulfillment");
  assert(duplicateWebhook.duplicate === true, "Stripe webhook replay was not idempotent.");

  const walletAfterTopup = (await pool.query(`SELECT balance FROM credit_wallets WHERE workspace_id = $1`, [workspaceId])).rows[0].balance;
  assert(walletAfterTopup === 15000, `Expected 15,000 credits after Stripe top-up, received ${walletAfterTopup}.`);
  const purchaseCount = (await pool.query(
    `SELECT count(*)::int AS count FROM credit_ledger WHERE workspace_id = $1 AND type = 'PURCHASE' AND reference_id = $2`,
    [workspaceId, topupId],
  )).rows[0].count;
  assert(purchaseCount === 1, "Stripe webhook replay granted credits more than once.");

  await page.goto(`${baseUrl}/settings/billing?checkout=success`, { waitUntil: "networkidle" });
  await page.getByText("15,000", { exact: true }).first().waitFor({ timeout: 10_000 });
  assert(await page.getByText("Paid", { exact: true }).count() > 0, "Billing purchase history did not show the paid top-up.");
  await page.screenshot({ path: path.join(outputDir, "billing-after-topup-desktop.png"), fullPage: true });

  const adminOverview = (await api(adminContext, "GET", "/api/admin/overview", undefined, "admin overview")).data;
  assert(adminOverview.users >= 1 && adminOverview.workspaces >= 1, "Admin overview did not return platform totals.");

  await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText("Platform control plane", { exact: true }).waitFor();
  await assertNoHorizontalOverflow(page, "Admin desktop overview");
  await page.screenshot({ path: path.join(outputDir, "admin-overview-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Workspaces", exact: true }).click();
  const workspaceRow = page.locator("tbody tr", { hasText: "Milestone Ten Workspace" });
  await workspaceRow.waitFor({ timeout: 10_000 });
  await workspaceRow.locator("select").first().selectOption("GROWTH");
  await waitFor(
    pool,
    `SELECT plan_id FROM workspace_plans WHERE workspace_id = $1`,
    [workspaceId],
    (rows) => rows.rows[0]?.plan_id === "GROWTH",
    "Growth plan assignment",
  );
  // Use the privileged API directly for deterministic financial verification; the visible control is covered by the Admin screenshot.
  await api(adminContext, "POST", `/api/admin/workspaces/${workspaceId}/credits`, {
    amount: 500,
    reason: "Milestone 10 browser verification",
  }, "admin credit adjustment");
  const balanceAfterAdjustment = (await pool.query(`SELECT balance FROM credit_wallets WHERE workspace_id = $1`, [workspaceId])).rows[0].balance;
  assert(balanceAfterAdjustment === 15500, "Admin credit adjustment did not update the wallet.");

  await api(adminContext, "POST", "/api/admin/rates", {
    capability: "SMS",
    provider: `m10-provider-${stamp}`,
    model: "",
    unit: "SMS_SEGMENT",
    costMicros: 9000,
    unitsPerCost: 1,
    targetMarginBps: 5500,
    effectiveFrom: new Date().toISOString(),
  }, "create hosted rate version");

  const auditCount = (await pool.query(
    `SELECT count(*)::int AS count FROM admin_audit_logs WHERE actor_user_id = $1`,
    [adminUserId],
  )).rows[0].count;
  assert(auditCount >= 3, "Platform admin mutations were not written to the audit log.");

  await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByText(/Growth · 0 of 3 sub-user seats used/).waitFor({ timeout: 10_000 });
  assert(await page.getByPlaceholder("name@business.com").isVisible(), "Growth did not enable team invitations.");

  await api(userContext, "POST", "/api/auth/sign-up/email", {
    name: "Milestone Ten Suspended User",
    email: targetEmail,
    password,
  }, "target user sign up");
  const targetRow = await waitFor(
    pool,
    `SELECT u.id, m.workspace_id
       FROM "user" u
       JOIN memberships m ON m.user_id = u.id AND m.role = 'OWNER'
      WHERE u.email = $1
      ORDER BY m.created_at
      LIMIT 1`,
    [targetEmail],
    (rows) => rows.rowCount === 1,
    "target user provisioning",
  );
  const targetUserId = targetRow.rows[0].id;
  const targetWorkspaceId = targetRow.rows[0].workspace_id;
  await api(adminContext, "PATCH", `/api/admin/users/${targetUserId}`, {
    status: "SUSPENDED",
    suspensionReason: "Milestone 10 acceptance",
  }, "suspend user");
  await api(userContext, "GET", "/api/workspaces", undefined, "revoked suspended-user session", 401);

  await api(userContext, "POST", "/api/auth/sign-in/email", {
    email: targetEmail,
    password,
  }, "suspended user re-login");
  await api(userContext, "GET", "/api/workspaces", undefined, "suspended user workspace access after re-login", 403);
  await api(userContext, "POST", "/api/workspaces", {
    workspaceId: targetWorkspaceId,
  }, "suspended user direct workspace switch", 403);

  await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByText(targetEmail, { exact: true }).waitFor({ timeout: 10_000 });
  const suspendedRow = page.locator("tbody tr", { hasText: targetEmail });
  assert(await suspendedRow.getByText("SUSPENDED", { exact: true }).isVisible(), "Admin Users table did not surface suspension.");
  await page.screenshot({ path: path.join(outputDir, "admin-users-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Hosted API pricing", exact: true }).click();
  await page.getByText(`m10-provider-${stamp}`, { exact: true }).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: path.join(outputDir, "admin-pricing-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/settings/billing`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Billing & Usage", exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "Billing mobile");
  await page.screenshot({ path: path.join(outputDir, "billing-mobile.png"), fullPage: true });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "Admin mobile");
  await page.screenshot({ path: path.join(outputDir, "admin-overview-mobile.png"), fullPage: true });

  assert(runtimeErrors.length === 0, `Browser/runtime errors detected: ${runtimeErrors.join(" | ")}`);
  console.log("Milestone 10 browser verification passed for live Billing, signed/idempotent Stripe credit fulfillment, Personal/Growth plan enforcement, platform admin controls, audit history, session revocation plus post-login suspension enforcement, and responsive Billing/Admin layouts.");
} finally {
  await pool.end();
  await adminContext.close();
  await userContext.close();
  await browser.close();
}

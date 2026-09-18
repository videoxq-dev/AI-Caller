import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 9 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "milestone9-browser");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(context, method, route, data, label) {
  const response = await context.request.fetch(`${baseUrl}${route}`, {
    method,
    data,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
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

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const runtimeErrors = [];

page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 500) runtimeErrors.push(`HTTP ${response.status()} ${response.url()}`);
});

const stamp = Date.now();
const email = `milestone9-owner-${stamp}@example.com`;
const password = "BrowserSmokePass123!";

try {
  await api(context, "POST", "/api/auth/sign-up/email", {
    name: "Milestone Nine Owner",
    email,
    password,
  }, "owner sign up");

  const ownerRow = await waitFor(
    pool,
    `SELECT u.id AS user_id, m.workspace_id
       FROM "user" u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'
      ORDER BY m.created_at
      LIMIT 1`,
    [email],
    (rows) => rows.rowCount === 1,
    "owner workspace provisioning",
  );
  const workspaceId = ownerRow.rows[0].workspace_id;

  await pool.query(`UPDATE workspaces SET name = 'Milestone Nine Workspace' WHERE id = $1`, [workspaceId]);
  await pool.query(
    `INSERT INTO credit_wallets (workspace_id, balance)
     VALUES ($1, 88)
     ON CONFLICT (workspace_id) DO UPDATE SET balance = 88, updated_at = now()`,
    [workspaceId],
  );

  const contact = await pool.query(
    `INSERT INTO contacts (workspace_id, name, phone)
     VALUES ($1, 'M9 Dashboard Customer', '+12025550900')
     RETURNING id`,
    [workspaceId],
  );
  const conversation = await pool.query(
    `INSERT INTO conversations (workspace_id, contact_id, handling_mode, last_message_at, created_at)
     VALUES ($1, $2, 'HUMAN', now(), now() - interval '1 hour')
     RETURNING id`,
    [workspaceId, contact.rows[0].id],
  );
  await pool.query(
    `INSERT INTO messages (workspace_id, conversation_id, channel, direction, sender_type, content_type, body, provider, external_message_id, status, created_at)
     VALUES
       ($1, $2, 'SMS', 'INBOUND', 'CUSTOMER', 'TEXT', 'I need an appointment.', 'fixture', $3, 'RECEIVED', now() - interval '55 minutes'),
       ($1, $2, 'SMS', 'OUTBOUND', 'AI', 'TEXT', 'I can help with that.', 'fixture', $4, 'SENT', now() - interval '50 minutes')`,
    [workspaceId, conversation.rows[0].id, `m9-in-${randomUUID()}`, `m9-out-${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO leads (workspace_id, contact_id, status, source, qualification_score, qualification_completed_at)
     VALUES ($1, $2, 'QUALIFIED', 'SMS', 100, now() - interval '45 minutes')`,
    [workspaceId, contact.rows[0].id],
  );
  await pool.query(
    `INSERT INTO appointments (workspace_id, contact_id, conversation_id, title, starts_at, ends_at, timezone, status, booking_source, created_at)
     VALUES ($1, $2, $3, 'M9 Consultation', now() + interval '2 days', now() + interval '2 days 30 minutes', 'UTC', 'CONFIRMED', 'M9_ACCEPTANCE', now() - interval '40 minutes')`,
    [workspaceId, contact.rows[0].id, conversation.rows[0].id],
  );
  await pool.query(
    `INSERT INTO conversation_handling_events (workspace_id, conversation_id, type, reason, created_at)
     VALUES ($1, $2, 'TAKEOVER', 'M9 acceptance takeover', now() - interval '35 minutes')`,
    [workspaceId, conversation.rows[0].id],
  );

  const overview = await api(context, "GET", "/api/dashboard?days=7", undefined, "load dashboard API");
  assert(overview.metrics?.inquiries?.value === 1, "Dashboard API did not count the live inquiry.");
  assert(overview.metrics?.aiConversations?.value === 1, "Dashboard API did not count the AI conversation.");
  assert(overview.metrics?.qualifiedLeads?.value === 1, "Dashboard API did not count the qualified lead.");
  assert(overview.metrics?.appointments?.value === 1, "Dashboard API did not count the appointment.");
  assert(overview.metrics?.humanTakeovers?.value === 1, "Dashboard API did not count the human takeover.");
  assert(overview.credit?.balance === 88, "Dashboard API did not return the workspace credit balance.");

  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByLabel("Dashboard date range").selectOption("7");
  const inquiryValue = page.locator(".metricCard", { hasText: "New inquiries" }).locator(".metricValue");
  await inquiryValue.waitFor({ timeout: 10_000 });
  assert(await inquiryValue.innerText() === "1", "Dashboard inquiry card is not live.");
  assert(await page.locator(".metricCard", { hasText: "Credit balance" }).locator(".metricValue").innerText() === "88", "Dashboard credit card is not live.");
  assert(await page.getByText("M9 Dashboard Customer", { exact: false }).count() > 0, "Recent activity did not surface the seeded customer.");
  assert(await page.getByLabel("Active workspace").inputValue() === workspaceId, "Dashboard is not using shared AppNav workspace state.");
  await assertNoHorizontalOverflow(page, "Live dashboard desktop");
  await page.screenshot({ path: path.join(outputDir, "dashboard-desktop.png"), fullPage: true });

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "AI Agent", exact: true }).waitFor({ timeout: 10_000 });
  assert(await page.getByLabel("Active workspace").inputValue() === workspaceId, "AI Agent did not use shared AppNav.");
  await assertNoHorizontalOverflow(page, "AI Agent shared AppNav desktop");
  await page.screenshot({ path: path.join(outputDir, "ai-agent-appnav-desktop.png"), fullPage: true });

  await page.goto(`${baseUrl}/integrations`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Integrations", exact: true }).waitFor({ timeout: 10_000 });
  assert(await page.getByLabel("Active workspace").inputValue() === workspaceId, "Integrations did not use shared AppNav.");
  await assertNoHorizontalOverflow(page, "Integrations shared AppNav desktop");
  await page.screenshot({ path: path.join(outputDir, "integrations-appnav-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "Live dashboard mobile");
  await page.screenshot({ path: path.join(outputDir, "dashboard-mobile.png"), fullPage: true });

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "AI Agent", exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "AI Agent shared AppNav mobile");
  await page.screenshot({ path: path.join(outputDir, "ai-agent-appnav-mobile.png"), fullPage: true });

  await page.goto(`${baseUrl}/integrations`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Integrations", exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "Integrations shared AppNav mobile");
  for (const destination of ["Automations", "Integrations", "Settings"]) {
    assert(await page.getByRole("link", { name: destination, exact: true }).isVisible(), `${destination} is hidden from the mobile AppNav.`);
  }
  await page.screenshot({ path: path.join(outputDir, "integrations-appnav-mobile.png"), fullPage: true });

  assert(runtimeErrors.length === 0, `Browser/runtime errors detected: ${runtimeErrors.join(" | ")}`);
  console.log("Milestone 9 browser verification passed for live workspace dashboard metrics, activity, responsive layout, and shared AppNav on Dashboard, AI Agent, and Integrations.");
} finally {
  await pool.end();
  await context.close();
  await browser.close();
}

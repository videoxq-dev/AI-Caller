import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 4 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "milestone4-browser");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function parseResponse(response, label) {
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok()) throw new Error(`${label} failed with ${response.status()}: ${text.slice(0, 1000)}`);
  return parsed;
}

async function api(context, method, route, data, label) {
  const response = await context.request.fetch(`${baseUrl}${route}`, {
    method,
    data,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
  });
  return parseResponse(response, label);
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  const overflow = Math.max(metrics.scrollWidth, metrics.bodyScrollWidth) - metrics.clientWidth;
  assert(overflow <= 2, `${label} has ${overflow}px of horizontal overflow.`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 500) runtimeErrors.push(`HTTP ${response.status()} ${response.url()}`);
});

const email = `milestone4-browser-${Date.now()}@example.com`;
await api(context, "POST", "/api/auth/sign-up/email", {
  name: "Milestone Four QA",
  email,
  password: "BrowserSmokePass123!",
}, "sign up");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
let workspaceId;
try {
  for (let attempt = 0; attempt < 20 && !workspaceId; attempt += 1) {
    const result = await pool.query(
      `SELECT m.workspace_id FROM memberships m INNER JOIN "user" u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    );
    workspaceId = result.rows[0]?.workspace_id ?? null;
    if (!workspaceId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(workspaceId, "Default workspace was not created for the Milestone 4 browser user.");

  await pool.query(
    `INSERT INTO business_profiles (workspace_id, business_name, industry, timezone, summary)
     VALUES ($1, 'Milestone Four Auto Spa', 'Auto detailing', 'UTC', 'A test business used to verify the Milestone 4 orchestrator and website chat flow.')
     ON CONFLICT (workspace_id) DO UPDATE SET business_name = EXCLUDED.business_name, industry = EXCLUDED.industry, timezone = EXCLUDED.timezone, summary = EXCLUDED.summary, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_agents (workspace_id, name, status, tone, primary_goal, when_unsure, opening_message, escalation_message)
     VALUES ($1, 'QA Assistant', 'ACTIVE', 'Friendly & professional', 'Book appointments', 'Escalate to a human', 'Hi! How can I help?', 'I will connect you with the team.')
     ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, tone = EXCLUDED.tone, primary_goal = EXCLUDED.primary_goal, when_unsure = EXCLUDED.when_unsure, opening_message = EXCLUDED.opening_message, escalation_message = EXCLUDED.escalation_message, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO services (workspace_id, name, description, price_text, duration_minutes, active)
     VALUES ($1, 'QA Consultation', 'A 30 minute consultation used for the browser acceptance flow.', '$120', 30, true)`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO faqs (workspace_id, question, answer, active)
     VALUES ($1, 'How much is the QA Consultation?', 'The QA Consultation is $120.', true)`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO credit_wallets (workspace_id, balance) VALUES ($1, 100)
     ON CONFLICT (workspace_id) DO UPDATE SET balance = 100, updated_at = now()`,
    [workspaceId],
  );
  for (let day = 0; day < 7; day += 1) {
    await pool.query(
      `INSERT INTO business_hours (workspace_id, day_of_week, enabled, open_time, close_time)
       VALUES ($1, $2, true, '08:00', '18:00')
       ON CONFLICT (workspace_id, day_of_week) DO UPDATE
       SET enabled = true, open_time = '08:00', close_time = '18:00', updated_at = now()`,
      [workspaceId, day],
    );
  }

  const integration = await pool.query(
    `INSERT INTO integrations (workspace_id, category, provider, mode, status, settings)
     VALUES ($1, 'CALENDAR', 'google', 'BYOP', 'ERROR', '{}'::jsonb)
     RETURNING id`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO capability_bindings (workspace_id, capability, integration_id, mode)
     VALUES ($1, 'CALENDAR', $2, 'BYOP')
     ON CONFLICT (workspace_id, capability) DO UPDATE SET integration_id = EXCLUDED.integration_id, mode = EXCLUDED.mode, updated_at = now()`,
    [workspaceId, integration.rows[0].id],
  );
  const staleCalendarBinding = await pool.query(
    `SELECT cb.integration_id, i.status
       FROM capability_bindings cb
       LEFT JOIN integrations i ON i.id = cb.integration_id
      WHERE cb.workspace_id = $1 AND cb.capability = 'CALENDAR'`,
    [workspaceId],
  );
  assert(staleCalendarBinding.rows[0]?.status === "ERROR",
    "Milestone 4 did not create the stale external calendar route used to verify native fallback.");


  const upload = await parseResponse(await context.request.post(`${baseUrl}/api/knowledge/files`, {
    multipart: { file: {
      name: "qa-services.txt", mimeType: "text/plain",
      buffer: Buffer.from("QA Car Spa accepts weekend appointments only by advance booking."),
    } },
  }), "upload business knowledge");
  assert(upload.source?.label === "qa-services.txt", "Knowledge upload did not persist.");
  const known = await api(context, "GET", "/api/knowledge", undefined, "list business knowledge");
  assert(known.sources?.some((item) => item.id === upload.source.id), "Knowledge is not listed.");
  assert(!known.sources?.some((item) => Object.hasOwn(item, "content")), "Knowledge list exposed source content.");
  const blocked = await context.request.post(`${baseUrl}/api/knowledge/website`, { data: { url: "http://127.0.0.1/internal" } });
  assert(blocked.status() === 422, "Private-network website import was not rejected.");
  await page.goto(`${baseUrl}/setup/ai`, { waitUntil: "networkidle" });
  await page.getByText("qa-services.txt", { exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "Knowledge importer desktop");
  await page.screenshot({ path: path.join(outputDir, "business-knowledge-import.png"), fullPage: true });
  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("heading", { name: "Business knowledge" }).waitFor();
  await page.getByText("qa-services.txt", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: /Add service/i }).waitFor();
  assert(page.url().endsWith("/ai-agent"), "AI Agent Knowledge redirected back into onboarding.");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("heading", { name: "Test your AI" }).waitFor();
  await page.getByPlaceholder("Type a test message...").fill("How much is the QA Consultation?");
  await page.locator(".testComposer button").click();
  await page.getByText(/QA Consultation is \$120/).last().waitFor({ timeout: 15_000 });
  await page.getByText(/data-ai-caller-key=/).waitFor({ timeout: 15_000 });
  await assertNoHorizontalOverflow(page, "AI Agent Test desktop");
  await page.screenshot({ path: path.join(outputDir, "ai-agent-test-desktop.png"), fullPage: true });

  const testPollution = await pool.query(
    `SELECT count(*)::int AS count
       FROM contact_identities
      WHERE workspace_id = $1 AND external_id LIKE 'agent-test:%'`,
    [workspaceId],
  );
  assert(testPollution.rows[0].count === 0, "AI Agent Test created a live contact identity.");
  const balanceAfterTest = (await pool.query(`SELECT balance FROM credit_wallets WHERE workspace_id = $1`, [workspaceId])).rows[0].balance;

  const config = await api(context, "GET", "/api/widget/config", undefined, "load widget config");
  assert(typeof config?.publicKey === "string", "Widget config did not return a public key.");
  const widgetKey = config.publicKey;

  await page.setContent(`<!doctype html><html><body><h1>Host website</h1><script async src="${baseUrl}/widget/loader" data-ai-caller-key="${widgetKey}"></script></body></html>`);
  await page.getByRole("button", { name: "Open chat" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open chat" }).click();
  const widgetFrame = page.frameLocator(`iframe[src*="/widget/${widgetKey}"]`);
  await widgetFrame.getByText("QA Assistant", { exact: true }).waitFor({ timeout: 15_000 });

  const composer = widgetFrame.getByPlaceholder("Type your message…");
  let delayedWidgetRequest = false;
  await page.route("**/api/widget/messages", async (route) => {
    if (!delayedWidgetRequest) {
      delayedWidgetRequest = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await route.continue();
  });
  await composer.fill("How much is the QA Consultation?");
  await composer.press("Enter");
  await widgetFrame.getByLabel("AI is typing").waitFor({ timeout: 2_000 });
  await widgetFrame.getByText(/QA Consultation is \$120/).last().waitFor({ timeout: 15_000 });
  await page.unroute("**/api/widget/messages");

  await composer.fill("What times are available tomorrow?");
  await composer.press("Enter");
  await widgetFrame.getByText(/I checked the schedule\. Available times include .*10:00 AM/).waitFor({ timeout: 15_000 });

  const bookingMessage = "My name is QA Visitor, qa.visitor@example.com. Book the 10:00 AM slot";
  await composer.fill(bookingMessage);
  await composer.press("Enter");
  await widgetFrame.getByText(/Would you like me to book it\?/i).last().waitFor({ timeout: 15_000 });

  const stagedSession = await pool.query(
    `SELECT conversation_id FROM webchat_sessions
      WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  const stagedConversationId = stagedSession.rows[0]?.conversation_id;
  assert(stagedConversationId, "Widget booking proposal did not retain its conversation.");
  const preConfirmationBooking = await pool.query(
    `SELECT count(*)::int AS count FROM appointments
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  assert(preConfirmationBooking.rows[0].count === 0,
    "Widget booking executed before explicit customer confirmation.");
  const stagedAction = await pool.query(
    `SELECT status FROM pending_agent_actions
      WHERE workspace_id = $1 AND conversation_id = $2 AND type = 'BOOK_APPOINTMENT'
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, stagedConversationId],
  );
  assert(stagedAction.rows[0]?.status === "AWAITING_CONFIRMATION",
    "Widget booking proposal was not persisted as awaiting confirmation.");

  await composer.fill("Yes, please.");
  await composer.press("Enter");
  await widgetFrame.getByText(/Your QA Consultation is booked for .*10:00 AM/).waitFor({ timeout: 15_000 });
  await assertNoHorizontalOverflow(page, "Embedded Web Chat desktop");
  await page.screenshot({ path: path.join(outputDir, "webchat-desktop.png"), fullPage: true });

  const sessionRow = await pool.query(
    `SELECT s.contact_id, s.conversation_id
       FROM webchat_sessions s
      WHERE s.workspace_id = $1
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [workspaceId],
  );
  assert(sessionRow.rows[0], "Public widget did not persist a web chat session.");
  const { contact_id: contactId, conversation_id: conversationId } = sessionRow.rows[0];

  const contactRow = await pool.query(
    `SELECT name, email FROM contacts WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
    [workspaceId, contactId],
  );
  assert(contactRow.rows[0]?.name === "QA Visitor", `Expected captured visitor name, received ${contactRow.rows[0]?.name ?? "none"}.`);
  assert(contactRow.rows[0]?.email === "qa.visitor@example.com", `Expected captured visitor email, received ${contactRow.rows[0]?.email ?? "none"}.`);

  const identityRow = await pool.query(
    `SELECT count(*)::int AS count FROM contact_identities
      WHERE workspace_id = $1 AND contact_id = $2 AND channel = 'WEBCHAT'`,
    [workspaceId, contactId],
  );
  assert(identityRow.rows[0].count === 1, "Widget visitor was not linked to a WEBCHAT contact identity.");

  const leadRow = await pool.query(
    `SELECT status, intent, service_requested FROM leads WHERE workspace_id = $1 AND contact_id = $2 LIMIT 1`,
    [workspaceId, contactId],
  );
  assert(leadRow.rows[0]?.status === "BOOKED", `Expected BOOKED lead, received ${leadRow.rows[0]?.status ?? "none"}.`);
  assert(leadRow.rows[0]?.service_requested === "QA Consultation", "Lead service request was not persisted.");

  const appointmentRow = await pool.query(
    `SELECT status, title, booking_source, external_event_id FROM appointments
      WHERE workspace_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, contactId],
  );
  assert(appointmentRow.rows[0]?.status === "CONFIRMED", "Widget booking did not persist a confirmed appointment.");
  assert(appointmentRow.rows[0]?.title === "QA Consultation", "Widget booking persisted the wrong appointment title.");
  assert(appointmentRow.rows[0]?.booking_source === "WEBCHAT_AI", "Widget booking source was not WEBCHAT_AI.");
  assert(Boolean(appointmentRow.rows[0]?.external_event_id), "Widget booking did not persist the provider event id.");

  const messageRow = await pool.query(
    `SELECT sender_type, content_type, body FROM messages
      WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at ASC`,
    [workspaceId, conversationId],
  );
  const bodies = messageRow.rows.map((row) => row.body);
  for (const expected of [
    "How much is the QA Consultation?",
    "What times are available tomorrow?",
    bookingMessage,
    "Yes, please.",
    "Appointment booked: QA Consultation",
  ]) assert(bodies.includes(expected), `Timeline is missing: ${expected}`);
  assert(messageRow.rows.filter((row) => row.sender_type === "AI" && row.content_type === "TEXT").length === 4, "Expected four persisted AI replies including booking preview and confirmation.");

  const balanceAfterWidget = (await pool.query(`SELECT balance FROM credit_wallets WHERE workspace_id = $1`, [workspaceId])).rows[0].balance;
  assert(balanceAfterWidget === balanceAfterTest - 3, `Expected three hosted AI credit debits for the widget flow (confirmation commits the stored action without another planning call); balance moved from ${balanceAfterTest} to ${balanceAfterWidget}.`);
  const usageCount = (await pool.query(
    `SELECT count(*)::int AS count FROM usage_events WHERE workspace_id = $1 AND capability = 'AI_TEXT'`,
    [workspaceId],
  )).rows[0].count;
  assert(usageCount >= 4, `Expected at least four AI usage events including Test tab and three widget planning turns; received ${usageCount}.`);

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
  await page.getByText("How much is the QA Consultation?", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("Appointment booked: QA Consultation", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("QA Visitor", { exact: true }).first().waitFor({ timeout: 15_000 });
  await assertNoHorizontalOverflow(page, "Inbox after Web Chat booking");
  await page.screenshot({ path: path.join(outputDir, "inbox-after-booking.png"), fullPage: true });

  await page.goto(`${baseUrl}/appointments`, { waitUntil: "networkidle" });
  await page.getByText("QA Consultation", { exact: true }).first().waitFor({ timeout: 15_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html><html><body><h1>Mobile host</h1><script async src="${baseUrl}/widget/loader" data-ai-caller-key="${widgetKey}"></script></body></html>`);
  await page.getByRole("button", { name: "Open chat" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open chat" }).click();
  await page.frameLocator(`iframe[src*="/widget/${widgetKey}"]`).getByText("QA Assistant", { exact: true }).waitFor({ timeout: 15_000 });
  await assertNoHorizontalOverflow(page, "Embedded Web Chat mobile");
  await page.screenshot({ path: path.join(outputDir, "webchat-mobile.png"), fullPage: true });

  assert(runtimeErrors.length === 0, `Milestone 4 browser runtime errors:\n${runtimeErrors.join("\n")}`);
  console.log("Milestone 4 browser acceptance passed: Test tab isolation, knowledge response, contact capture, qualification, availability, booking, credits, persistence, Inbox, and responsive widget rendering.");
} finally {
  await pool.end();
  await browser.close();
}

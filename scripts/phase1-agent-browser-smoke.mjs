import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for Phase 1 acceptance.");
const dir = path.join(process.cwd(), "artifacts", "phase1-agent");
await mkdir(dir, { recursive: true });

function assert(ok, message) { if (!ok) throw new Error(message); }

async function api(context, method, route, data, label, expected = 200) {
  const response = await context.request.fetch(`${baseUrl}${route}`, {
    method, data, headers: data === undefined ? undefined : { "content-type": "application/json" },
  });
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  assert(response.status() === expected,
    `${label}: expected HTTP ${expected}, received ${response.status()}: ${body.slice(0, 700)}`);
  return parsed;
}

async function noOverflow(page, label) {
  const width = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
      - document.documentElement.clientWidth);
  assert(width <= 2, `${label}: ${width}px horizontal overflow`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("response", response => {
  if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`);
});

try {
  const email = `phase1-agent-${Date.now()}@example.com`;
  await api(context, "POST", "/api/auth/sign-up/email", {
    name: "Phase One Owner", email, password: "BrowserSmokePass123!",
  }, "sign up");
  const owners = await pool.query(`SELECT m.workspace_id, u.id AS user_id FROM memberships m
    JOIN "user" u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`, [email]);
  const workspaceId = owners.rows[0]?.workspace_id;
  const purchaserUserId = owners.rows[0]?.user_id;
  assert(workspaceId && purchaserUserId, "Workspace and owner were not provisioned.");

  // Retain explicit legacy/rollback coverage. The durable production default is
  // verified separately by booking-remediation-browser-smoke.mjs.
  await pool.query(
    `INSERT INTO workspace_entitlements (workspace_id, key, value)
     VALUES ($1, 'BOOKING_ENGINE_VERSION', '"v1"'::jsonb)
     ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [workspaceId],
  );


  const beforeCapacity = await api(context, "GET", "/api/workspaces", undefined,
    "read Core business capacity");
  assert(beforeCapacity.capacity?.ownedBusinesses === 1
    && beforeCapacity.capacity?.businessLimit === 1
    && beforeCapacity.capacity?.availableBusinesses === 0,
  "Core workspace capacity API did not report its initial one-business limit.");

  const beforeUpgrade = await api(context, "PUT", "/api/workspaces", {
    name: "Phase One Second Workspace",
  }, "Core cannot create an additional business", 403);
  assert(beforeUpgrade.error?.code === "WORKSPACE_LIMIT_REACHED",
    "Business capacity was not enforced before the Unlimited purchase.");

  // Acceptance fixture: validate the real workspace creation/switch API with
  // the account-level commercial entitlement that authorizes two businesses.
  // Never bypass the production quota or weaken its server-side enforcement.
  await pool.query(
    `INSERT INTO licenses
       (workspace_id, purchaser_user_id, source, external_purchase_id,
        product_code, status, purchased_at)
     VALUES ($1, $2, 'MANUAL', $3, 'UNLIMITED', 'ACTIVE', now())`,
    [workspaceId, purchaserUserId, "phase1-unlimited-" + Date.now()],
  );

  const additional = await api(context, "PUT", "/api/workspaces", {
    name: "Phase One Second Workspace",
  }, "create an additional workspace after Unlimited upgrade", 201);
  assert(additional.workspace?.role === "OWNER"
    && additional.workspace?.workspaceName === "Phase One Second Workspace",
  "Workspace creation did not return a new owner workspace.");
  const afterCreate = await api(context, "GET", "/api/workspaces", undefined,
    "list workspaces after creation");
  assert(afterCreate.workspaces?.length === 2
    && afterCreate.activeWorkspaceId === additional.workspace.workspaceId,
  "The new workspace was not available and selected after creation.");
  assert(afterCreate.capacity?.ownedBusinesses === 2
    && afterCreate.capacity?.businessLimit === 2
    && afterCreate.capacity?.availableBusinesses === 0,
  "Unlimited workspace capacity API did not reflect the purchased business allowance.");
  await api(context, "POST", "/api/workspaces", { workspaceId },
    "switch back to the original workspace");
  const switched = await api(context, "GET", "/api/workspaces", undefined,
    "verify original workspace switch");
  assert(switched.activeWorkspaceId === workspaceId,
    "The owner could not switch back to the original workspace.");

  const empty = await api(context, "GET", "/api/agent", undefined, "read new agent");
  assert(empty.agent === null, "An unconfigured workspace showed a fictional agent.");
  await api(context, "PATCH", "/api/agent/status",
    { status: "ACTIVE" }, "cannot activate a missing agent", 409);

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.locator(".navWorkspaceCapacity").getByText(/2 of 2 business slots used\\./).waitFor();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.getByRole("button", { name: "Behavior", exact: true }).click();
  await page.getByLabel("Assistant name").fill("Mia");
  await page.getByLabel("Primary goal").selectOption("Answer questions");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Capabilities", exact: true }).click();
  assert(await page.getByRole("button", { name: "Book appointments", exact: true })
    .getAttribute("aria-pressed") === "true",
    "A newly created agent did not populate its capability toggles without a page reload.");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  let agent = await api(context, "GET", "/api/agent", undefined, "read persisted Mia");
  assert(agent.agent.name === "Mia" && agent.agent.status === "DRAFT",
    "Saving agent settings incorrectly activated Mia.");
  assert(agent.capabilityCatalog.some(item => item.key === "BOOK_APPOINTMENT"),
    "Booking capability missing from the registered catalog.");
  assert(agent.capabilities.BOOK_APPOINTMENT === true,
    "Legacy-default booking permission changed unexpectedly.");

  await pool.query(`INSERT INTO business_profiles
    (workspace_id, business_name, industry, timezone, summary)
    VALUES ($1, 'Phase One Auto Spa', 'Auto detailing', 'UTC', 'Bookings are available by appointment.')
    ON CONFLICT (workspace_id) DO UPDATE SET business_name = EXCLUDED.business_name`, [workspaceId]);
  await pool.query(`INSERT INTO business_hours (workspace_id, day_of_week, enabled, open_time, close_time)
    SELECT $1, n, true, '08:00', '18:00' FROM generate_series(0, 6) n
    ON CONFLICT (workspace_id, day_of_week) DO UPDATE SET
      enabled=true, open_time='08:00', close_time='18:00'`, [workspaceId]);
  await pool.query(`INSERT INTO services
    (workspace_id, name, description, price_text, duration_minutes, active)
    VALUES ($1, 'QA Consultation', 'Thirty-minute appointment.', '$120', 30, true)`, [workspaceId]);
  const automations = await pool.query(`SELECT count(*)::int AS count FROM automation_settings
    WHERE workspace_id = $1`, [workspaceId]);
  assert(automations.rows[0].count === 0, "Acceptance workspace unexpectedly has automations.");

  await pool.query(`INSERT INTO credit_wallets (workspace_id, balance) VALUES ($1, 85)
    ON CONFLICT (workspace_id) DO UPDATE SET balance=85`, [workspaceId]);
  const contact = await pool.query(`INSERT INTO contacts (workspace_id, name)
    VALUES ($1, 'Phase One Visitor') RETURNING id`, [workspaceId]);
  const conversation = await pool.query(`INSERT INTO conversations
    (workspace_id, contact_id, handling_mode, created_at, last_message_at)
    VALUES ($1, $2, 'AI', now(), now()) RETURNING id`,
  [workspaceId, contact.rows[0].id]);
  await pool.query(`INSERT INTO messages
    (workspace_id, conversation_id, direction, sender_type, channel, content_type, body, status)
    VALUES ($1, $2, 'INBOUND', 'CUSTOMER', 'WEBCHAT', 'TEXT', 'What hours are you open?', 'RECEIVED')`,
  [workspaceId, conversation.rows[0].id]);

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByText("Agent draft", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Mia", exact: true }).waitFor();
  await page.getByText("85", { exact: true }).waitFor();
  await page.getByText("Phase One Visitor", { exact: false }).waitFor();
  await noOverflow(page, "Phase 1 overview desktop");
  await page.screenshot({ path: path.join(dir, "agent-draft-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Capabilities", exact: true }).click();
  const booking = page.getByRole("button", { name: "Book appointments", exact: true });
  assert(await booking.getAttribute("aria-pressed") === "true",
    "Booking capability toggle did not reflect its saved state.");
  await booking.click();
  await page.getByRole("button", { name: "Save capabilities" }).click();
  await page.waitForFunction(async () => {
    const response = await fetch("/api/agent", { cache: "no-store" });
    if (!response.ok) return false;
    const stored = await response.json();
    return stored.capabilities?.BOOK_APPOINTMENT === false;
  }, null, { timeout: 10_000 });
  agent = await api(context, "GET", "/api/agent", undefined, "read revoked booking");
  assert(agent.capabilities.BOOK_APPOINTMENT === false,
    "Booking toggle was cosmetic rather than persisted.");

  await api(context, "PATCH", "/api/agent", {
    name: "Mia", tone: "Professional", primaryGoal: "Answer questions",
    whenUnsure: "Escalate to a human", guardrails: [],
    qualification: { enabled: false, criteria: [] }, completeStep: false,
  }, "edit agent without re-enabling booking");
  agent = await api(context, "GET", "/api/agent", undefined, "check booking after agent edit");
  assert(agent.capabilities.BOOK_APPOINTMENT === false,
    "An ordinary agent edit silently re-enabled booking.");

  const all = Object.fromEntries(agent.capabilityCatalog.map(item =>
    [item.key, item.key !== "BOOK_APPOINTMENT"]));
  const bad = await api(context, "PATCH", "/api/agent/capabilities",
    { ...all, MALICIOUS_TOOL: true }, "reject unknown tool", 422);
  assert(bad.error?.code, "Unknown tool did not return a structured error.");

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Activate agent" }).click();
  await page.getByText("Agent active", { exact: true }).waitFor();
  assert((await api(context, "GET", "/api/agent", undefined, "read activation")).agent.status === "ACTIVE",
    "Activation did not persist.");
  assert((await api(context, "GET", "/api/setup/status", undefined, "go-live progress")).setup.steps.live,
    "Agent activation did not mark the onboarding go-live step.");

  const ordinary = await api(context, "POST", "/api/agent/test", {
    message: "How much is the QA Consultation?", reset: true,
  }, "ordinary conversation with no automations");
  assert(ordinary.reply.includes("QA Consultation is $120"),
    "Enabled Mia could not answer business knowledge without automations.");

  const forged = await api(context, "POST", "/api/agent/test", {
    message: "Book the QA Consultation, my name is QA Visitor, qa.visitor@example.com.",
    reset: true,
  }, "forged model booking when disabled");
  assert((forged.reply?.includes("can't book") || forged.reply?.includes("can't perform"))
    && !forged.reply?.includes("booked for"),
    "Mia claimed success when the model attempted a disabled booking.");
  const appointments = await pool.query(`SELECT count(*)::int AS count FROM appointments
    WHERE workspace_id = $1`, [workspaceId]);
  assert(appointments.rows[0].count === 0,
    "A disabled agent booking created an actual appointment.");

  const widget = await api(context, "GET", "/api/widget/config", undefined, "load public Web Chat widget");
  assert(widget.publicKey, "Web Chat widget is missing.");
  await page.setContent(`<!doctype html><html><body><h1>Business website</h1>
    <script async src="${baseUrl}/widget/loader" data-ai-caller-key="${widget.publicKey}"></script>
    </body></html>`);
  await page.getByRole("button", { name: "Open chat" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open chat" }).click();
  const widgetFrame = page.frameLocator(`iframe[src*="/widget/${widget.publicKey}"]`);
  const composer = widgetFrame.getByPlaceholder("Type your message…");
  await composer.fill("How much is the QA Consultation?");
  await widgetFrame.getByRole("button", { name: "Send message" }).click();
  await widgetFrame.getByText(/QA Consultation is \$120/).last().waitFor({ timeout: 15_000 });
  await composer.fill("Book the QA Consultation. My name is QA Visitor, qa.visitor@example.com");
  await widgetFrame.getByRole("button", { name: "Send message" }).click();
  await widgetFrame.getByText(/can't book an appointment.*flagged this issue for staff follow-up/i)
    .last().waitFor({ timeout: 15_000 });
  const forbiddenBookings = await pool.query(`SELECT count(*)::int AS count FROM appointments
    WHERE workspace_id = $1`, [workspaceId]);
  assert(forbiddenBookings.rows[0].count === 0,
    "The real Web Chat channel persisted a booking disabled by the owner.");
  const webchatSession = await pool.query(
    `SELECT conversation_id FROM webchat_sessions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  const liveConversationId = webchatSession.rows[0]?.conversation_id;
  assert(liveConversationId, "Phase 1 Web Chat did not expose its conversation.");
  const [ownership, issueCase] = await Promise.all([
    pool.query(`SELECT handling_mode FROM conversations WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, liveConversationId]),
    pool.query(`SELECT status FROM conversation_human_cases
      WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, liveConversationId]),
  ]);
  assert(ownership.rows[0]?.handling_mode === "AI",
    "Issue-scoped staff follow-up incorrectly locked the whole conversation away from AI.");
  assert(["OPEN", "CLAIMED"].includes(issueCase.rows[0]?.status),
    "When Unsure = Escalate to a human did not create an open issue-specific staff case.");

  // Re-enable booking and prove the same conversation can continue with AI
  // while the unrelated staff issue remains open.
  const policy = await api(context, "GET", "/api/agent", undefined, "read stored permissions");
  await api(context, "PATCH", "/api/agent/capabilities", {
    ...policy.capabilities, BOOK_APPOINTMENT: true,
  }, "enable native booking");
  await composer.fill("Book the QA Consultation for tomorrow at 10 AM. My name is QA Visitor, qa.visitor@example.com");
  await widgetFrame.getByRole("button", { name: "Send message" }).click();
  await widgetFrame.getByText(/Would you like me to book it\?/i).last().waitFor({ timeout: 15_000 });
  const beforeConfirmation = await api(context, "GET", "/api/appointments", undefined,
    "verify staged booking has not executed");
  assert(beforeConfirmation.total === 0,
    "A staged Web Chat booking executed before explicit customer confirmation.");
  const pendingBooking = await pool.query(`SELECT status FROM pending_agent_actions
    WHERE workspace_id = $1 AND conversation_id = $2 AND type = 'BOOK_APPOINTMENT'
    ORDER BY created_at DESC LIMIT 1`, [workspaceId, liveConversationId]);
  assert(pendingBooking.rows[0]?.status === "AWAITING_CONFIRMATION",
    "The booking was not persisted as an awaiting-confirmation action.");

  await composer.fill("Yes, please.");
  await widgetFrame.getByRole("button", { name: "Send message" }).click();
  await widgetFrame.getByText(/QA Consultation is booked for/).last().waitFor({ timeout: 15_000 });
  const nativeBookings = await api(context, "GET", "/api/appointments", undefined,
    "read native in-app appointment after explicit confirmation");
  assert(nativeBookings.total === 1
    && nativeBookings.items[0].appointment.status === "CONFIRMED"
    && nativeBookings.items[0].appointment.integrationId === null,
    "The approved Web Chat booking did not appear on the Appointments page data.");
  await page.screenshot({ path: path.join(dir, "native-booking-webchat.png"), fullPage: true });
  await api(context, "PATCH", "/api/agent/capabilities", {
    ...policy.capabilities, BOOK_APPOINTMENT: false,
  }, "restore disabled booking for status persistence checks");

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Agent active", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause agent" }).click();
  await page.getByText("Agent paused", { exact: true }).waitFor();
  assert((await api(context, "GET", "/api/agent", undefined, "read pause")).agent.status === "PAUSED",
    "Pause did not persist.");

  await page.setContent(`<!doctype html><html><body><h1>Paused business website</h1>
    <script async src="${baseUrl}/widget/loader" data-ai-caller-key="${widget.publicKey}"></script>
    </body></html>`);
  await page.getByRole("button", { name: "Open chat" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open chat" }).click();
  const pausedFrame = page.frameLocator(`iframe[src*="/widget/${widget.publicKey}"]`);
  const pausedComposer = pausedFrame.getByPlaceholder("Type your message…");
  await pausedComposer.fill("Hello, Mia, are you there?");
  await pausedFrame.getByRole("button", { name: "Send message" }).click();
  try {
    await pausedFrame.getByText(/AI assistant is currently unavailable/).waitFor({ timeout: 15_000 });
  } catch (error) {
    const visible = await pausedFrame.locator("body").innerText().catch(() => "Widget inaccessible");
    console.error("Paused Web Chat UI after send:", visible.slice(-1400));
    await page.screenshot({ path: path.join(dir, "paused-agent-debug.png"), fullPage: true });
    throw error;
  }
  // The widget polls authoritative history every four seconds; an unavailable
  // notice is not a persisted AI reply and must survive that refresh.
  await page.waitForTimeout(4_600);
  assert(await pausedFrame.getByText(/AI assistant is currently unavailable/).isVisible(),
    "Paused-agent notice disappeared after Web Chat history refresh.");
  assert(await pausedFrame.getByText("A team member is handling this conversation.").count() === 0,
    "Paused agent falsely claimed an actual staff handoff.");
  await page.screenshot({ path: path.join(dir, "paused-agent-webchat.png"), fullPage: true });

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByText("Agent paused", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Activate agent" }).click();
  await page.getByText("Agent active", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Return to draft" }).click();
  await page.getByText("Agent draft", { exact: true }).waitFor();
  assert((await api(context, "GET", "/api/agent", undefined, "read returned draft")).agent.status === "DRAFT",
    "Return to draft did not persist.");
  await page.getByRole("button", { name: "Activate agent" }).click();
  await page.getByText("Agent active", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Capabilities", exact: true }).click();
  assert(await page.getByRole("button", { name: "Book appointments", exact: true })
    .getAttribute("aria-pressed") === "false",
  "Booking revocation was lost across status changes and reload.");
  await noOverflow(page, "Phase 1 capabilities desktop");
  await page.screenshot({ path: path.join(dir, "agent-capabilities-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await noOverflow(page, "Phase 1 overview mobile");
  await page.screenshot({ path: path.join(dir, "agent-overview-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Capabilities", exact: true }).click();
  await noOverflow(page, "Phase 1 capabilities mobile");
  await page.screenshot({ path: path.join(dir, "agent-capabilities-mobile.png"), fullPage: true });

  // Open an existing Inbox conversation on mobile and land at its most recent
  // message, not at the beginning of a long customer history.
  await pool.query(`INSERT INTO messages
    (workspace_id, conversation_id, direction, sender_type, channel, content_type, body, status, created_at)
    SELECT $1, $2, 'OUTBOUND', 'AI', 'WEBCHAT', 'TEXT',
      CASE WHEN seq = 30 THEN 'LATEST INBOX ACCEPTANCE MESSAGE'
        ELSE 'Earlier conversation message ' || seq END,
      'DELIVERED', now() + seq * interval '1 second'
    FROM generate_series(1, 30) AS seq`,
  [workspaceId, conversation.rows[0].id]);
  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  const selected = page.getByRole("button", { name: /Phase One Visitor/ }).first();
  await selected.click();
  const latest = page.getByText("LATEST INBOX ACCEPTANCE MESSAGE", { exact: true });
  await latest.waitFor({ timeout: 10_000 });
  const thread = page.locator(".threadBody");
  assert(await thread.isVisible(), "Selecting a mobile conversation did not open the thread.");
  const atBottom = await thread.evaluate(el =>
    el.scrollHeight - el.scrollTop - el.clientHeight < 96);
  assert(atBottom, "Mobile thread opened at the beginning instead of newest messages.");
  await noOverflow(page, "Phase 1 mobile Inbox");
  await page.screenshot({ path: path.join(dir, "inbox-mobile-newest.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to conversations" }).click();
  assert(await selected.isVisible(), "Mobile Inbox back action did not show conversations.");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await selected.click();
  await latest.waitFor({ timeout: 10_000 });
  assert(await thread.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 96),
    "Desktop thread did not open at newest messages.");
  await thread.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(350);
  assert(await thread.evaluate(el => el.scrollTop === 0),
    "Inbox hijacked manual scrolling to older messages.");
  await page.screenshot({ path: path.join(dir, "inbox-desktop-history.png"), fullPage: true });

  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log("Phase 1 browser acceptance passed: persisted agent, activation/pause, capability revocation, settings preservation, real metrics, desktop/mobile layout.");
} finally {
  await pool.end();
  await context.close();
  await browser.close();
}

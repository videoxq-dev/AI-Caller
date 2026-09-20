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
  const owners = await pool.query(`SELECT m.workspace_id FROM memberships m
    JOIN "user" u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`, [email]);
  const workspaceId = owners.rows[0]?.workspace_id;
  assert(workspaceId, "Workspace was not provisioned.");

  const empty = await api(context, "GET", "/api/agent", undefined, "read new agent");
  assert(empty.agent === null, "An unconfigured workspace showed a fictional agent.");
  await api(context, "PATCH", "/api/agent/status",
    { status: "ACTIVE" }, "cannot activate a missing agent", 409);

  await api(context, "PATCH", "/api/agent", {
    name: "Mia", tone: "Friendly & professional", primaryGoal: "Answer questions",
    whenUnsure: "Escalate to a human", guardrails: ["Never invent pricing"],
    voice: { profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
      recordingPolicy: "ANNOUNCE", afterHoursEnabled: true },
    qualification: { enabled: false, criteria: [] }, completeStep: true,
  }, "configure Mia");
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
  assert(forged.reply?.includes("can't perform that action")
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
  await composer.press("Enter");
  await widgetFrame.getByText(/QA Consultation is \$120/).last().waitFor({ timeout: 15_000 });
  await composer.fill("Book the QA Consultation. My name is QA Visitor, qa.visitor@example.com");
  await composer.press("Enter");
  await widgetFrame.getByText(/can't perform that action/).last().waitFor({ timeout: 15_000 });
  const forbiddenBookings = await pool.query(`SELECT count(*)::int AS count FROM appointments
    WHERE workspace_id = $1`, [workspaceId]);
  assert(forbiddenBookings.rows[0].count === 0,
    "The real Web Chat channel persisted a booking disabled by the owner.");

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
  await pausedComposer.press("Enter");
  await pausedFrame.getByText(/AI assistant is currently unavailable/).waitFor({ timeout: 15_000 });
  assert(await pausedFrame.getByText("A team member is handling this conversation.").count() === 0,
    "Paused agent falsely claimed an actual staff handoff.");
  await page.screenshot({ path: path.join(dir, "paused-agent-webchat.png"), fullPage: true });

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByText("Agent paused", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Activate agent" }).click();

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

  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log("Phase 1 browser acceptance passed: persisted agent, activation/pause, capability revocation, settings preservation, real metrics, desktop/mobile layout.");
} finally {
  await pool.end();
  await context.close();
  await browser.close();
}

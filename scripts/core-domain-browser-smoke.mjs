import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "core-domain-browser");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function parseResponse(response, label) {
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Raw response is included below if the request failed.
  }
  if (!response.ok()) throw new Error(`${label} failed with ${response.status()}: ${text.slice(0, 1000)}`);
  return parsed;
}

async function request(context, method, route, data, label) {
  const response = await context.request.fetch(`${baseUrl}${route}`, {
    method,
    data,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
  });
  return parseResponse(response, label);
}

async function waitForText(page, text) {
  await page.getByText(text, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
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

async function assertContactDrawerRowsSeparated(page) {
  const rows = page.locator(".contactDrawer .drawerDetails > div");
  const count = await rows.count();
  assert(count >= 3, "Contact drawer detail rows were not rendered.");
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const labelBox = await row.locator("span").boundingBox();
    const valueBox = await row.locator("strong").boundingBox();
    if (!labelBox || !valueBox) continue;
    assert(valueBox.x >= labelBox.x + labelBox.width + 4, `Contact drawer row ${index + 1} label overlaps its value.`);
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 500) runtimeErrors.push(`HTTP ${response.status()} ${response.url()}`);
});

const email = `milestone3-browser-${Date.now()}@example.com`;
await request(context, "POST", "/api/auth/sign-up/email", {
  name: "Milestone Three QA",
  email,
  password: "BrowserSmokePass123!",
}, "sign up");

const contactData = await request(context, "POST", "/api/contacts", {
  name: "Browser QA Contact",
  email: "browser.qa.contact@example.com",
  phone: "+1 (415) 555-0123",
  notes: "Persisted contact created by the Milestone 3 browser verification.",
  tags: ["Consultation", "Priority"],
  identities: [
    { channel: "PHONE", externalId: "+1 (415) 555-0123" },
    { channel: "SMS", externalId: "+1 (415) 555-0123" },
    { channel: "WHATSAPP", externalId: "+1 (415) 555-0123" },
    { channel: "WEBCHAT", externalId: "browser-qa-session-001" },
  ],
}, "create contact");
const contactId = contactData?.contact?.id;
assert(typeof contactId === "string", "Contact creation did not return an id.");

await request(context, "PUT", `/api/contacts/${contactId}/lead`, {
  status: "QUALIFIED",
  intent: "Book a consultation",
  serviceRequested: "Consultation",
  source: "WEBCHAT",
  estimatedValue: 15000,
}, "upsert lead");

const conversationData = await request(context, "POST", "/api/conversations", { contactId }, "create conversation");
const conversationId = conversationData?.conversation?.id;
assert(typeof conversationId === "string", "Conversation creation did not return an id.");

for (const message of [
  { channel: "WEBCHAT", direction: "INBOUND", senderType: "CUSTOMER", body: "I need a consultation from web chat.", provider: "browser-smoke", externalMessageId: "browser-message-1" },
  { channel: "WHATSAPP", direction: "OUTBOUND", senderType: "AI", body: "I can help with that. I also recognize your WhatsApp identity.", provider: "browser-smoke", externalMessageId: "browser-message-2" },
  { channel: "SMS", direction: "INBOUND", senderType: "CUSTOMER", body: "Please confirm the appointment by SMS too.", provider: "browser-smoke", externalMessageId: "browser-message-3" },
]) {
  await request(context, "POST", `/api/conversations/${conversationId}/messages`, message, `append ${message.channel} message`);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  let workspaceId = null;
  for (let attempt = 0; attempt < 20 && !workspaceId; attempt += 1) {
    const result = await pool.query(
      `SELECT m.workspace_id FROM memberships m INNER JOIN "user" u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    );
    workspaceId = result.rows[0]?.workspace_id ?? null;
    if (!workspaceId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(workspaceId, "Default workspace was not created for the browser verification user.");

  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  startsAt.setUTCMinutes(0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
  await pool.query(
    `INSERT INTO appointments
      (workspace_id, contact_id, conversation_id, title, starts_at, ends_at, timezone, status, booking_source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONFIRMED', $8, $9)`,
    [workspaceId, contactId, conversationId, "QA Consultation", startsAt, endsAt, "America/New_York", "WEBCHAT", "Persisted local appointment used to verify the Appointments UI."],
  );
} finally {
  await pool.end();
}

async function verifyDesktop() {
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto(`${baseUrl}/contacts`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Contacts", level: 1 }).waitFor();
  await waitForText(page, "Browser QA Contact");
  await page.locator("tbody tr", { hasText: "Browser QA Contact" }).click();
  await page.getByRole("heading", { name: "Browser QA Contact" }).waitFor();
  await waitForText(page, "Channel identities");
  for (const label of ["Phone · +1 (415) 555-0123", "SMS · +1 (415) 555-0123", "WhatsApp · +1 (415) 555-0123", "Web Chat · browser-qa-session-001"]) await waitForText(page, label);
  await assertContactDrawerRowsSeparated(page);
  await assertNoHorizontalOverflow(page, "Contacts desktop");
  await page.screenshot({ path: path.join(outputDir, "contacts-desktop.png"), fullPage: true });

  await page.goto(`${baseUrl}/appointments`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Appointments", level: 1 }).waitFor();
  await waitForText(page, "QA Consultation");
  await page.getByRole("heading", { name: "QA Consultation" }).waitFor();
  await waitForText(page, "Browser QA Contact");
  await assertNoHorizontalOverflow(page, "Appointments desktop");
  await page.screenshot({ path: path.join(outputDir, "appointments-desktop.png"), fullPage: true });

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
  await waitForText(page, "I need a consultation from web chat.");
  await waitForText(page, "I can help with that. I also recognize your WhatsApp identity.");
  await waitForText(page, "Please confirm the appointment by SMS too.");
  for (const channel of ["Web Chat", "WhatsApp", "SMS"]) {
    await page.locator(".messageMeta .channelBadge").filter({ hasText: channel }).first().waitFor({ state: "visible" });
  }

  const channelFilter = page.getByLabel("Channel filter");
  await channelFilter.selectOption("PHONE");
  await waitForText(page, "No conversations match this channel.");
  await channelFilter.selectOption("ALL");
  await waitForText(page, "Browser QA Contact");

  await page.getByRole("button", { name: "Human takeover" }).click();
  await page.getByRole("button", { name: "Return to AI" }).waitFor({ state: "visible" });
  const timelineData = await request(context, "GET", `/api/conversations/${conversationId}`, undefined, "read conversation after takeover");
  assert(timelineData?.timeline?.conversation?.handlingMode === "HUMAN", "Human takeover was not persisted.");
  await page.getByRole("button", { name: "Return to AI" }).click();
  await page.getByRole("button", { name: "Human takeover" }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, "Inbox desktop");
  await page.screenshot({ path: path.join(outputDir, "inbox-desktop.png"), fullPage: true });
}

async function verifyMobile() {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["contacts", "appointments", "inbox"]) {
    await page.goto(`${baseUrl}/${route}`, { waitUntil: "networkidle" });
    await assertNoHorizontalOverflow(page, `${route} mobile`);
    if (route === "contacts") await waitForText(page, "Browser QA Contact");
    if (route === "appointments") await waitForText(page, "QA Consultation");
    if (route === "inbox") await waitForText(page, "Browser QA Contact");
    await page.screenshot({ path: path.join(outputDir, `${route}-mobile.png`), fullPage: true });
  }
}

try {
  await verifyDesktop();
  await verifyMobile();
  assert(runtimeErrors.length === 0, `Browser runtime errors:\n${runtimeErrors.join("\n")}`);
  console.log("Milestone 3 browser verification passed for Contacts, Appointments, and Inbox at desktop and mobile widths.");
} finally {
  await browser.close();
}

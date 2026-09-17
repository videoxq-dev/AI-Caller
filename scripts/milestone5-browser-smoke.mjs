import { createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const twilioToken = process.env.HOSTED_SMS_TWILIO_AUTH_TOKEN;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 5 browser verification.");
if (!twilioToken) throw new Error("HOSTED_SMS_TWILIO_AUTH_TOKEN is required for Milestone 5 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "milestone5-browser");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function twilioSignature(url, rawBody, token) {
  const pairs = Array.from(new URLSearchParams(rawBody).entries()).sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  return createHmac("sha1", token).update(`${url}${pairs.map(([key, value]) => `${key}${value}`).join("")}`, "utf8").digest("base64");
}

async function sendTwilioWebhook(workspaceId, values, signature = true) {
  const url = `${baseUrl}/api/webhooks/sms/twilio/${workspaceId}`;
  const body = new URLSearchParams(values).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ? twilioSignature(url, body, twilioToken) : "invalid",
    },
    body,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!payload && response.headers.get("content-type")?.includes("text/xml")) {
    payload = {
      queued: Number(response.headers.get("x-ai-caller-queued") ?? 0),
      processed: Number(response.headers.get("x-ai-caller-processed") ?? 0),
      duplicates: Number(response.headers.get("x-ai-caller-duplicates") ?? 0),
      deferred: Number(response.headers.get("x-ai-caller-deferred") ?? 0),
    };
  }
  return { response, payload, text };
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

const email = `milestone5-browser-${Date.now()}@example.com`;
await api(context, "POST", "/api/auth/sign-up/email", {
  name: "Milestone Five QA",
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
  assert(workspaceId, "Default workspace was not created for the Milestone 5 browser user.");

  await pool.query(
    `INSERT INTO business_profiles (workspace_id, business_name, industry, timezone, summary)
     VALUES ($1, 'Milestone Five Auto Spa', 'Auto detailing', 'UTC', 'A test business used to verify the SMS orchestrator flow.')
     ON CONFLICT (workspace_id) DO UPDATE SET business_name = EXCLUDED.business_name, industry = EXCLUDED.industry, timezone = EXCLUDED.timezone, summary = EXCLUDED.summary, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_agents (workspace_id, name, status, tone, primary_goal, when_unsure, opening_message, escalation_message)
     VALUES ($1, 'SMS QA Assistant', 'ACTIVE', 'Friendly & professional', 'Book appointments', 'Escalate to a human', 'Hi! How can I help?', 'I will connect you with the team.')
     ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, tone = EXCLUDED.tone, primary_goal = EXCLUDED.primary_goal, when_unsure = EXCLUDED.when_unsure, opening_message = EXCLUDED.opening_message, escalation_message = EXCLUDED.escalation_message, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO services (workspace_id, name, description, price_text, duration_minutes, active)
     VALUES ($1, 'QA Consultation', 'A 30 minute consultation used for the SMS acceptance flow.', '$120', 30, true)`,
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
  const calendarIntegration = await pool.query(
    `INSERT INTO integrations (workspace_id, category, provider, mode, status, settings)
     VALUES ($1, 'CALENDAR', 'calcom', 'BYOP', 'CONNECTED', '{}'::jsonb)
     RETURNING id`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO capability_bindings (workspace_id, capability, integration_id, mode)
     VALUES ($1, 'CALENDAR', $2, 'BYOP'), ($1, 'SMS', NULL, 'HOSTED')
     ON CONFLICT (workspace_id, capability) DO UPDATE SET integration_id = EXCLUDED.integration_id, mode = EXCLUDED.mode, updated_at = now()`,
    [workspaceId, calendarIntegration.rows[0].id],
  );
  const hostedCommunicationSettings = {
    voice: { mode: "HOSTED", provider: null, numberMode: "new", number: "+12025550200" },
    sms: { mode: "HOSTED", provider: null, numberMode: "same", number: null, displayName: "Milestone Five Auto Spa", replyWindow: "Always respond", afterHoursBehavior: "Auto-reply + collect details" },
    whatsapp: { mode: "BYOP", provider: "whatsapp", accountMode: "existing" },
    webchat: { enabled: true },
  };
  await pool.query(
    `INSERT INTO communication_setup_settings (workspace_id, settings)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
    [workspaceId, JSON.stringify(hostedCommunicationSettings)],
  );
  await pool.query(
    `INSERT INTO integrations (workspace_id, category, provider, mode, status, settings)
     VALUES ($1, 'COMMUNICATION', 'telnyx', 'BYOP', 'CONNECTED', $2::jsonb)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET category = 'COMMUNICATION', mode = 'BYOP', status = 'CONNECTED', settings = EXCLUDED.settings, updated_at = now()`,
    [workspaceId, JSON.stringify({ phone: "+12025550299" })],
  );

  await page.goto(`${baseUrl}/setup/communication`, { waitUntil: "networkidle" });
  await page.locator(".channelTabs button").filter({ hasText: "SMS" }).click();
  await page.getByRole("button", { name: /Use my own provider \(BYOP\)/ }).click();
  const callbackInput = page.getByLabel("SMS callback URL");
  await callbackInput.waitFor();
  const callbackSuffix = `/api/webhooks/sms/telnyx/${workspaceId}`;
  await page.waitForFunction(
    (suffix) => {
      const input = document.querySelector('input[aria-label="SMS callback URL"]');
      return input instanceof HTMLInputElement && input.value.endsWith(suffix);
    },
    callbackSuffix,
    { timeout: 10_000 },
  );
  const callbackValue = await callbackInput.inputValue();
  assert(callbackValue.endsWith(callbackSuffix), `Unexpected Telnyx callback URL: ${callbackValue}`);
  const publicKeyInput = page.getByLabel("Webhook signing public key");
  await publicKeyInput.waitFor();
  await assertNoHorizontalOverflow(page, "BYOP SMS webhook setup desktop");
  await page.screenshot({ path: path.join(outputDir, "sms-byop-setup-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page, "BYOP SMS webhook setup mobile");
  await page.screenshot({ path: path.join(outputDir, "sms-byop-setup-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const telnyxPublicKey = Buffer.alloc(32, 7).toString("base64");
  await publicKeyInput.fill(telnyxPublicKey);
  await page.getByRole("button", { name: "Save for later" }).click();
  await page.getByText("Communication settings saved.", { exact: true }).waitFor({ timeout: 10_000 });
  const telnyxSettings = await pool.query(
    `SELECT settings FROM integrations WHERE workspace_id = $1 AND provider = 'telnyx' LIMIT 1`,
    [workspaceId],
  );
  assert(telnyxSettings.rows[0]?.settings?.webhookPublicKey === telnyxPublicKey, "Telnyx signing public key was not persisted through the SMS setup UI.");
  const publicConfig = await api(context, "GET", "/api/integrations/sms/config?provider=telnyx", undefined, "load public Telnyx SMS config");
  assert(publicConfig?.webhookPublicKeyConfigured === true, "Public SMS config did not report the saved Telnyx signing key.");
  assert(!JSON.stringify(publicConfig).includes(telnyxPublicKey), "Public SMS config exposed the Telnyx signing public key value.");

  await pool.query(
    `UPDATE capability_bindings SET mode = 'HOSTED', integration_id = NULL, updated_at = now() WHERE workspace_id = $1 AND capability = 'SMS'`,
    [workspaceId],
  );
  await pool.query(
    `UPDATE communication_setup_settings SET settings = $2::jsonb, updated_at = now() WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify(hostedCommunicationSettings)],
  );

  const invalid = await sendTwilioWebhook(workspaceId, {
    MessageSid: "SM-invalid-signature",
    From: "+12025550100",
    To: "+12025550200",
    Body: "Should be rejected",
    SmsStatus: "received",
  }, false);
  assert(invalid.response.status === 401, `Expected invalid SMS signature to return 401, received ${invalid.response.status}.`);

  const turns = [
    { sid: "SM-m5-1", body: "How much is the QA Consultation?", expectedReply: "QA Consultation is $120. I can also check tomorrow's availability." },
    { sid: "SM-m5-2", body: "What times are available tomorrow?", expectedReply: "I have a 10:00 AM opening tomorrow." },
    { sid: "SM-m5-3", body: "My name is SMS Visitor, sms.visitor@example.com. Book the 10:00 AM slot", expectedReply: "Your QA Consultation is booked for 10:00 AM tomorrow." },
  ];

  let conversationId;
  for (const turn of turns) {
    const webhook = await sendTwilioWebhook(workspaceId, {
      MessageSid: turn.sid,
      From: "+12025550100",
      To: "+12025550200",
      Body: turn.body,
      SmsStatus: "received",
    });
    assert(webhook.response.status === 200, `Expected Twilio SMS webhook 200 for ${turn.sid}, received ${webhook.response.status}: ${webhook.text}`);
    assert(webhook.response.headers.get("content-type")?.includes("text/xml"), `Expected Twilio SMS webhook XML response for ${turn.sid}.`);
    assert(webhook.text.includes("<Response>"), `Expected Twilio SMS webhook TwiML response for ${turn.sid}.`);
    assert(webhook.payload?.queued === 1, `Expected ${turn.sid} to queue one SMS response.`);

    const result = await waitFor(
      pool,
      `SELECT c.id AS conversation_id, m.body, m.external_message_id, m.status
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.workspace_id = $1 AND m.channel = 'SMS' AND m.direction = 'OUTBOUND' AND m.body = $2
        ORDER BY m.created_at DESC LIMIT 1`,
      [workspaceId, turn.expectedReply],
      (rows) => rows.rowCount === 1 && Boolean(rows.rows[0].external_message_id),
      `outbound SMS for ${turn.sid}`,
    );
    conversationId = result.rows[0].conversation_id;
  }
  assert(conversationId, "SMS flow did not create a conversation.");

  const duplicate = await sendTwilioWebhook(workspaceId, {
    MessageSid: "SM-m5-3",
    From: "+12025550100",
    To: "+12025550200",
    Body: turns[2].body,
    SmsStatus: "received",
  });
  assert(duplicate.response.status === 200, "Duplicate SMS webhook was not safely acknowledged with TwiML.");
  assert(duplicate.payload?.duplicates === 1, "Duplicate SMS webhook was not identified as a duplicate.");
  const messageCountAfterDuplicate = (await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2`, [workspaceId, conversationId])).rows[0].count;

  const contact = await pool.query(
    `SELECT c.id, c.name, c.email, c.phone
       FROM contacts c
       JOIN conversations conv ON conv.contact_id = c.id
      WHERE c.workspace_id = $1 AND conv.id = $2 LIMIT 1`,
    [workspaceId, conversationId],
  );
  assert(contact.rows[0]?.name === "SMS Visitor", `Expected captured SMS visitor name, received ${contact.rows[0]?.name ?? "none"}.`);
  assert(contact.rows[0]?.email === "sms.visitor@example.com", `Expected captured SMS visitor email, received ${contact.rows[0]?.email ?? "none"}.`);
  assert(contact.rows[0]?.phone === "+12025550100", "SMS contact phone was not normalized/persisted.");

  const identity = await pool.query(
    `SELECT count(*)::int AS count FROM contact_identities WHERE workspace_id = $1 AND contact_id = $2 AND channel = 'SMS' AND normalized_value = '+12025550100'`,
    [workspaceId, contact.rows[0].id],
  );
  assert(identity.rows[0].count === 1, "SMS contact identity was not persisted exactly once.");

  const lead = await pool.query(`SELECT status, source, service_requested FROM leads WHERE workspace_id = $1 AND contact_id = $2 LIMIT 1`, [workspaceId, contact.rows[0].id]);
  assert(lead.rows[0]?.status === "BOOKED", `Expected BOOKED SMS lead, received ${lead.rows[0]?.status ?? "none"}.`);
  assert(lead.rows[0]?.source === "SMS", `Expected SMS lead source, received ${lead.rows[0]?.source ?? "none"}.`);
  assert(lead.rows[0]?.service_requested === "QA Consultation", "SMS lead service request was not persisted.");

  const appointment = await pool.query(
    `SELECT status, title, booking_source, external_event_id FROM appointments WHERE workspace_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, contact.rows[0].id],
  );
  assert(appointment.rows[0]?.status === "CONFIRMED", "SMS booking did not persist a confirmed appointment.");
  assert(appointment.rows[0]?.booking_source === "SMS_AI", `Expected SMS_AI booking source, received ${appointment.rows[0]?.booking_source ?? "none"}.`);
  assert(Boolean(appointment.rows[0]?.external_event_id), "SMS booking did not persist provider event id.");

  const timeline = await pool.query(
    `SELECT channel, direction, sender_type, content_type, body, provider, external_message_id, status
       FROM messages WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at ASC`,
    [workspaceId, conversationId],
  );
  for (const turn of turns) {
    assert(timeline.rows.some((row) => row.channel === "SMS" && row.direction === "INBOUND" && row.body === turn.body), `SMS timeline is missing inbound: ${turn.body}`);
    assert(timeline.rows.some((row) => row.channel === "SMS" && row.direction === "OUTBOUND" && row.body === turn.expectedReply), `SMS timeline is missing outbound: ${turn.expectedReply}`);
  }
  assert(timeline.rows.some((row) => row.channel === "SMS" && row.content_type === "APPOINTMENT_EVENT" && row.body === "Appointment booked: QA Consultation"), "SMS appointment event was not attributed to SMS.");
  assert(timeline.rows.length === messageCountAfterDuplicate, "Duplicate inbound webhook added another timeline item.");

  const lastOutbound = [...timeline.rows].reverse().find((row) => row.direction === "OUTBOUND");
  assert(lastOutbound?.external_message_id, "SMS outbound provider message id was not persisted.");
  const delivery = await sendTwilioWebhook(workspaceId, {
    MessageSid: lastOutbound.external_message_id,
    MessageStatus: "delivered",
  });
  assert(delivery.response.status === 200, `Delivery callback failed with ${delivery.response.status}: ${delivery.text}`);
  assert(delivery.response.headers.get("content-type")?.includes("text/xml"), "Twilio delivery callback did not receive an XML acknowledgement.");
  await waitFor(
    pool,
    `SELECT status FROM messages WHERE workspace_id = $1 AND provider = 'twilio' AND external_message_id = $2 LIMIT 1`,
    [workspaceId, lastOutbound.external_message_id],
    (rows) => rows.rows[0]?.status === "DELIVERED",
    "SMS delivery status",
  );

  const smsUsage = await pool.query(`SELECT mode, provider, credits_charged FROM usage_events WHERE workspace_id = $1 AND capability = 'SMS' ORDER BY created_at`, [workspaceId]);
  assert(smsUsage.rowCount === 3, `Expected 3 SMS usage events, received ${smsUsage.rowCount}.`);
  assert(smsUsage.rows.every((row) => row.mode === "HOSTED" && row.provider === "twilio" && row.credits_charged === 1), "Hosted SMS usage attribution/credits are incorrect.");

  const balance = (await pool.query(`SELECT balance FROM credit_wallets WHERE workspace_id = $1`, [workspaceId])).rows[0].balance;
  assert(balance === 92, `Expected 8 total hosted credits consumed (5 AI + 3 SMS); received balance ${balance}.`);

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
  await page.getByText("How much is the QA Consultation?", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("Appointment booked: QA Consultation", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("SMS Visitor", { exact: true }).first().waitFor({ timeout: 15_000 });
  await assertNoHorizontalOverflow(page, "Inbox after SMS booking");
  await page.screenshot({ path: path.join(outputDir, "inbox-sms-desktop.png"), fullPage: true });

  const outboundBeforeHuman = (await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'OUTBOUND'`, [workspaceId, conversationId])).rows[0].count;
  await pool.query(`UPDATE conversations SET handling_mode = 'HUMAN', ai_paused_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2`, [workspaceId, conversationId]);
  const humanWebhook = await sendTwilioWebhook(workspaceId, {
    MessageSid: "SM-m5-human",
    From: "+12025550100",
    To: "+12025550200",
    Body: "A human is helping me now",
    SmsStatus: "received",
  });
  assert(humanWebhook.response.status === 200 && humanWebhook.payload?.queued === 1, "Human-mode inbound SMS was not safely queued/persisted with a TwiML acknowledgement.");
  await waitFor(
    pool,
    `SELECT status FROM provider_webhook_events WHERE workspace_id = $1 AND provider = 'twilio' AND external_event_id = 'SM-m5-human:received' LIMIT 1`,
    [workspaceId],
    (rows) => rows.rows[0]?.status === "PROCESSED",
    "human-mode SMS worker completion",
  );
  const outboundAfterHuman = (await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'OUTBOUND'`, [workspaceId, conversationId])).rows[0].count;
  assert(outboundAfterHuman === outboundBeforeHuman, "AI sent an SMS while the conversation was in HUMAN mode.");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("A human is helping me now", { exact: true }).waitFor({ timeout: 15_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
  await assertNoHorizontalOverflow(page, "Inbox SMS mobile");
  await page.screenshot({ path: path.join(outputDir, "inbox-sms-mobile.png"), fullPage: true });

  assert(runtimeErrors.length === 0, `Milestone 5 browser runtime errors:\n${runtimeErrors.join("\n")}`);
  console.log("Milestone 5 browser acceptance passed: BYOP webhook setup UI and metadata privacy, signed SMS webhook, provider-compatible TwiML acknowledgement, async worker, knowledge response, contact capture, qualification, availability, booking, hosted credits, duplicate suppression, delivery reconciliation, unified Inbox, and human takeover suppression.");
} finally {
  await pool.end();
  await browser.close();
}

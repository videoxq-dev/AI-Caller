import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const metaSecret = process.env.META_APP_SECRET;
const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
const encryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 6 browser verification.");
if (!metaSecret) throw new Error("META_APP_SECRET is required for Milestone 6 browser verification.");
if (!verifyToken) throw new Error("META_WEBHOOK_VERIFY_TOKEN is required for Milestone 6 browser verification.");
if (!encryptionKey) throw new Error("INTEGRATION_ENCRYPTION_KEY is required for Milestone 6 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "milestone6-browser");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function encryptCredentials(value) {
  const key = Buffer.from(encryptionKey, "base64");
  if (key.length !== 32) throw new Error("CI integration key must decode to 32 bytes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("ai-caller/provider-credentials/v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "A256GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function signature(rawBody) {
  return `sha256=${createHmac("sha256", metaSecret).update(rawBody, "utf8").digest("hex")}`;
}

function inboundPayload({ id, phoneNumberId, waId, text, profileName = "WhatsApp Visitor", timestamp = Math.floor(Date.now() / 1000) }) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-m6",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "+12025550300", phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: profileName }, wa_id: waId }],
          messages: [{ id, from: waId, timestamp: String(timestamp), type: "text", text: { body: text } }],
        },
      }],
    }],
  };
}

function statusPayload({ externalMessageId, phoneNumberId, status, timestamp }) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-m6",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "+12025550300", phone_number_id: phoneNumberId },
          statuses: [{ id: externalMessageId, status, timestamp: String(timestamp) }],
        },
      }],
    }],
  };
}

async function sendWebhook(payload, validSignature = true) {
  const rawBody = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": validSignature ? signature(rawBody) : `sha256=${"0".repeat(64)}`,
    },
    body: rawBody,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { response, text, data };
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
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  const overflow = metrics.scrollWidth - metrics.clientWidth;
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

const email = `milestone6-browser-${Date.now()}@example.com`;
await api(context, "POST", "/api/auth/sign-up/email", {
  name: "Milestone Six QA",
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
  assert(workspaceId, "Default workspace was not created for the Milestone 6 browser user.");

  await pool.query(
    `INSERT INTO business_profiles (workspace_id, business_name, industry, timezone, summary)
     VALUES ($1, 'Milestone Six Auto Spa', 'Auto detailing', 'UTC', 'A test business used to verify the WhatsApp orchestrator flow.')
     ON CONFLICT (workspace_id) DO UPDATE SET business_name = EXCLUDED.business_name, industry = EXCLUDED.industry, timezone = EXCLUDED.timezone, summary = EXCLUDED.summary, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_agents (workspace_id, name, status, tone, primary_goal, when_unsure, opening_message, escalation_message)
     VALUES ($1, 'WhatsApp QA Assistant', 'ACTIVE', 'Friendly & professional', 'Book appointments', 'Escalate to a human', 'Hi! How can I help?', 'I will connect you with the team.')
     ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, tone = EXCLUDED.tone, primary_goal = EXCLUDED.primary_goal, when_unsure = EXCLUDED.when_unsure, opening_message = EXCLUDED.opening_message, escalation_message = EXCLUDED.escalation_message, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO services (workspace_id, name, description, price_text, duration_minutes, active)
     VALUES ($1, 'QA Consultation', 'A 30 minute consultation used for the WhatsApp acceptance flow.', '$120', 30, true)`,
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

  const phoneNumberId = `phone-m6-${Date.now()}`;
  const waId = "15551234567";
  const waSettings = {
    authMethod: "EMBEDDED_SIGNUP",
    wabaId: "waba-m6",
    phoneNumberId,
    displayPhoneNumber: "+12025550300",
    verifiedName: "Milestone Six Auto Spa",
    webhookSubscribed: true,
  };
  const waCredentials = encryptCredentials({
    accessToken: "ci-meta-access-token",
    wabaId: "waba-m6",
    phoneNumberId,
  });
  const waIntegration = await pool.query(
    `INSERT INTO integrations (workspace_id, category, provider, mode, status, encrypted_credentials, settings)
     VALUES ($1, 'WHATSAPP', 'whatsapp', 'BYOP', 'CONNECTED', $2::jsonb, $3::jsonb)
     RETURNING id`,
    [workspaceId, JSON.stringify(waCredentials), JSON.stringify(waSettings)],
  );

  await pool.query(
    `INSERT INTO capability_bindings (workspace_id, capability, integration_id, mode)
     VALUES ($1, 'CALENDAR', $2, 'BYOP'), ($1, 'WHATSAPP', $3, 'BYOP')
     ON CONFLICT (workspace_id, capability) DO UPDATE SET integration_id = EXCLUDED.integration_id, mode = EXCLUDED.mode, updated_at = now()`,
    [workspaceId, calendarIntegration.rows[0].id, waIntegration.rows[0].id],
  );

  const challengeValue = "m6-verification-challenge";
  const challenge = await fetch(`${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challengeValue}`);
  assert(challenge.status === 200, `Expected WhatsApp webhook challenge 200, received ${challenge.status}.`);
  assert((await challenge.text()) === challengeValue, "WhatsApp webhook verification challenge did not echo the expected value.");

  const invalid = await sendWebhook(inboundPayload({ id: "wamid.m6.invalid", phoneNumberId, waId, text: "Reject this" }), false);
  assert(invalid.response.status === 401, `Expected invalid WhatsApp signature to return 401, received ${invalid.response.status}.`);

  const turns = [
    { id: "wamid.m6.1", text: "How much is the QA Consultation?",
      replyPattern: "QA Consultation is $120. I can also check tomorrow's availability." },
    { id: "wamid.m6.2", text: "What times are available tomorrow?",
      replyPattern: "%I checked the schedule. Available times include%10:00 AM%" },
    { id: "wamid.m6.3", text: "My name is WhatsApp Visitor, whatsapp.visitor@example.com. Book the 10:00 AM slot",
      replyPattern: "%Your QA Consultation is booked for%10:00 AM%" },
  ];

  let conversationId;
  let finalOutboundId;
  for (const turn of turns) {
    const webhook = await sendWebhook(inboundPayload({ id: turn.id, phoneNumberId, waId, text: turn.text }));
    assert(webhook.response.status === 200, `Expected WhatsApp webhook 200 for ${turn.id}, received ${webhook.response.status}: ${webhook.text}`);
    assert(webhook.data?.queued === 1, `Expected ${turn.id} to queue one WhatsApp response.`);

    const result = await waitFor(
      pool,
      `SELECT c.id AS conversation_id, m.external_message_id, m.status
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.workspace_id = $1 AND m.channel = 'WHATSAPP' AND m.direction = 'OUTBOUND' AND m.body LIKE $2
        ORDER BY m.created_at DESC LIMIT 1`,
      [workspaceId, turn.replyPattern],
      (rows) => rows.rowCount === 1 && Boolean(rows.rows[0].external_message_id),
      `outbound WhatsApp reply for ${turn.id}`,
    );
    conversationId = result.rows[0].conversation_id;
    finalOutboundId = result.rows[0].external_message_id;
  }
  assert(conversationId, "WhatsApp flow did not create a conversation.");
  assert(finalOutboundId, "WhatsApp booking reply did not receive a provider message ID.");

  const duplicateBefore = await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2`, [workspaceId, conversationId]);
  const duplicate = await sendWebhook(inboundPayload({ id: "wamid.m6.3", phoneNumberId, waId, text: turns[2].text }));
  assert(duplicate.response.status === 200 && duplicate.data?.duplicates === 1, "Duplicate WhatsApp inbound webhook was not recognized as a duplicate.");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const duplicateAfter = await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2`, [workspaceId, conversationId]);
  assert(duplicateAfter.rows[0].count === duplicateBefore.rows[0].count, "Duplicate WhatsApp webhook created duplicate timeline messages.");

  const identity = await pool.query(
    `SELECT ci.channel, ci.normalized_value, c.name, c.email
       FROM contact_identities ci JOIN contacts c ON c.id = ci.contact_id
      WHERE ci.workspace_id = $1 AND ci.channel = 'WHATSAPP' LIMIT 1`,
    [workspaceId],
  );
  assert(identity.rows[0]?.normalized_value === "+15551234567", "WhatsApp identity was not normalized onto the contact.");
  assert(identity.rows[0]?.name === "WhatsApp Visitor", "WhatsApp contact name was not captured.");
  assert(identity.rows[0]?.email === "whatsapp.visitor@example.com", "WhatsApp contact email was not captured by the orchestrator.");

  const lead = await pool.query(`SELECT status, source FROM leads WHERE workspace_id = $1 LIMIT 1`, [workspaceId]);
  assert(lead.rows[0]?.status === "BOOKED", `Expected WhatsApp lead BOOKED, got ${lead.rows[0]?.status}.`);
  assert(lead.rows[0]?.source === "WHATSAPP", `Expected WhatsApp lead source, got ${lead.rows[0]?.source}.`);
  const appointment = await pool.query(`SELECT status, booking_source FROM appointments WHERE workspace_id = $1 LIMIT 1`, [workspaceId]);
  assert(appointment.rows[0]?.status === "CONFIRMED", `Expected confirmed WhatsApp appointment, got ${appointment.rows[0]?.status}.`);
  assert(appointment.rows[0]?.booking_source === "WHATSAPP_AI", `Expected WHATSAPP_AI booking source, got ${appointment.rows[0]?.booking_source}.`);

  const statusBase = Math.floor(Date.now() / 1000);
  for (const [offset, status] of [[1, "sent"], [2, "delivered"], [3, "read"]]) {
    const webhook = await sendWebhook(statusPayload({ externalMessageId: finalOutboundId, phoneNumberId, status, timestamp: statusBase + offset }));
    assert(webhook.response.status === 200, `WhatsApp ${status} callback failed.`);
  }
  await waitFor(
    pool,
    `SELECT status FROM messages WHERE workspace_id = $1 AND external_message_id = $2 LIMIT 1`,
    [workspaceId, finalOutboundId],
    (rows) => rows.rows[0]?.status === "READ",
    "WhatsApp READ delivery status",
  );
  const stale = await sendWebhook(statusPayload({ externalMessageId: finalOutboundId, phoneNumberId, status: "sent", timestamp: statusBase + 4 }));
  assert(stale.response.status === 200, "Stale WhatsApp sent callback failed.");
  const afterStale = await pool.query(`SELECT status FROM messages WHERE workspace_id = $1 AND external_message_id = $2 LIMIT 1`, [workspaceId, finalOutboundId]);
  assert(afterStale.rows[0]?.status === "READ", "Out-of-order WhatsApp status downgraded READ state.");

  const usage = await pool.query(`SELECT count(*)::int AS count, coalesce(sum(credits_charged), 0)::int AS credits FROM usage_events WHERE workspace_id = $1 AND capability = 'WHATSAPP' AND mode = 'BYOP'`, [workspaceId]);
  assert(usage.rows[0].count >= 3, "WhatsApp BYOP usage events were not recorded.");
  assert(usage.rows[0].credits === 0, "WhatsApp BYOP transport incorrectly charged hosted credits.");

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await page.getByLabel("Channel filter").selectOption("WHATSAPP");
  await page.getByText("WhatsApp Visitor", { exact: true }).first().click();
  await page.getByText(/Your QA Consultation is booked for .*10:00 AM/).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "WhatsApp Inbox desktop");
  await page.screenshot({ path: path.join(outputDir, "whatsapp-inbox-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Human takeover" }).click();
  await page.getByRole("button", { name: "Return to AI" }).waitFor({ timeout: 10_000 });

  const aiOutboundBeforeHuman = await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND channel = 'WHATSAPP' AND sender_type = 'AI' AND direction = 'OUTBOUND'`, [workspaceId, conversationId]);
  const humanInboundId = "wamid.m6.human";
  const humanInbound = await sendWebhook(inboundPayload({ id: humanInboundId, phoneNumberId, waId, text: "I need a person to help me." }));
  assert(humanInbound.data?.queued === 1, "Human-mode inbound WhatsApp message was not queued for safe processing.");
  await waitFor(
    pool,
    `SELECT status FROM provider_webhook_events WHERE workspace_id = $1 AND provider = 'whatsapp' AND external_event_id = $2 LIMIT 1`,
    [workspaceId, humanInboundId],
    (rows) => rows.rows[0]?.status === "PROCESSED",
    "human-mode WhatsApp event processing",
  );
  const aiOutboundAfterHuman = await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND channel = 'WHATSAPP' AND sender_type = 'AI' AND direction = 'OUTBOUND'`, [workspaceId, conversationId]);
  assert(aiOutboundAfterHuman.rows[0].count === aiOutboundBeforeHuman.rows[0].count, "AI replied while the WhatsApp conversation was in HUMAN mode.");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Channel filter").selectOption("WHATSAPP");
  await page.getByText("WhatsApp Visitor", { exact: true }).first().click();
  const composer = page.getByLabel("Conversation reply");
  await composer.fill("Hi from the team — I can help.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Hi from the team — I can help.", { exact: true }).waitFor({ timeout: 10_000 });
  const staffMessage = await waitFor(
    pool,
    `SELECT sender_type, external_message_id, status FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND body = $3 LIMIT 1`,
    [workspaceId, conversationId, "Hi from the team — I can help."],
    (rows) => rows.rows[0]?.sender_type === "USER" && Boolean(rows.rows[0]?.external_message_id),
    "staff WhatsApp reply",
  );
  assert(staffMessage.rows[0].status === "SENT", "Staff WhatsApp reply did not persist SENT status.");

  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page, "WhatsApp Inbox mobile");
  await page.screenshot({ path: path.join(outputDir, "whatsapp-inbox-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const aiReplyCountBeforeResume = await pool.query(
    `SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND channel = 'WHATSAPP' AND direction = 'OUTBOUND' AND sender_type = 'AI' AND body = $3`,
    [workspaceId, conversationId, turns[0].replyPattern],
  );
  await page.getByRole("button", { name: "Return to AI" }).click();
  await page.getByRole("button", { name: "Human takeover" }).waitFor({ timeout: 10_000 });
  const resumed = await sendWebhook(inboundPayload({ id: "wamid.m6.resumed", phoneNumberId, waId, text: "How much is the QA Consultation?" }));
  assert(resumed.data?.queued === 1, "Return-to-AI WhatsApp message was not queued.");
  await waitFor(
    pool,
    `SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND channel = 'WHATSAPP' AND direction = 'OUTBOUND' AND sender_type = 'AI' AND body = $3`,
    [workspaceId, conversationId, turns[0].replyPattern],
    (rows) => rows.rows[0]?.count > aiReplyCountBeforeResume.rows[0].count,
    "new AI reply after return-to-AI",
  );

  const timeline = await pool.query(`SELECT channel, direction, sender_type, body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at`, [workspaceId, conversationId]);
  assert(timeline.rows.some((row) => row.channel === "WHATSAPP" && row.sender_type === "USER"), "Unified timeline does not contain the staff WhatsApp reply.");
  assert(timeline.rows.some((row) => row.channel === "WHATSAPP" && row.sender_type === "AI"), "Unified timeline does not contain AI WhatsApp replies.");
  assert(timeline.rows.some((row) => row.channel === "WHATSAPP" && row.sender_type === "CUSTOMER"), "Unified timeline does not contain customer WhatsApp messages.");

  assert(runtimeErrors.length === 0, `Browser/runtime errors detected: ${runtimeErrors.join(" | ")}`);
  console.log("Milestone 6 browser verification passed for signed Meta webhooks, shared orchestration/booking, BYOP usage, delivery reconciliation, human takeover/staff reply, return-to-AI, and responsive unified Inbox.");
} finally {
  await pool.end();
  await browser.close();
}

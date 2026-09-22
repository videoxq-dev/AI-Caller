import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 5 browser verification.");

const telnyxPrivateKey = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOgDv5zaVsY5ojeyMYHRlFb2ZKLJp62/+AxAzM+9lRMB
-----END PRIVATE KEY-----`);

const outputDir = path.join(process.cwd(), "artifacts", "milestone5-browser");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function telnyxEvent(eventType, eventId, payload) {
  return {
    data: {
      event_type: eventType,
      id: eventId,
      occurred_at: new Date().toISOString(),
      payload,
    },
  };
}

async function sendTelnyxWebhook(workspaceId, event, validSignature = true) {
  const url = `${baseUrl}/api/webhooks/sms/telnyx/${workspaceId}`;
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = validSignature
    ? sign(null, Buffer.from(`${timestamp}|${body}`, "utf8"), telnyxPrivateKey).toString("base64")
    : Buffer.alloc(64).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": signature,
    },
    body,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
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
  const metrics = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll("*")).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        className: typeof element.className === "string" ? element.className : null,
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
      };
    }).filter((rect) => rect.right > clientWidth + 2 || rect.left < -2)
      .sort((left, right) => Math.max(right.right - clientWidth, -right.left) - Math.max(left.right - clientWidth, -left.left))
      .slice(0, 8);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders,
    };
  });
  const overflow = Math.max(metrics.scrollWidth, metrics.bodyScrollWidth) - metrics.clientWidth;
  assert(overflow <= 2, `${label} has ${overflow}px of horizontal overflow. Offenders: ${JSON.stringify(metrics.offenders)}`);
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

  // Retain explicit legacy/rollback coverage. The durable production default is
  // verified separately by booking-remediation-browser-smoke.mjs.
  await pool.query(
    `INSERT INTO workspace_entitlements (workspace_id, key, value)
     VALUES ($1, 'BOOKING_ENGINE_VERSION', '"v1"'::jsonb)
     ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [workspaceId],
  );


  await pool.query(
    `INSERT INTO business_profiles (workspace_id, business_name, industry, timezone, summary)
     VALUES ($1, 'Milestone Five Auto Spa', 'Auto detailing', 'UTC', 'A test business used to verify the SMS orchestrator flow.')
     ON CONFLICT (workspace_id) DO UPDATE SET business_name = EXCLUDED.business_name, industry = EXCLUDED.industry, timezone = EXCLUDED.timezone, summary = EXCLUDED.summary, updated_at = now()`,
    [workspaceId],
  );
  // External calendars are also constrained by the workspace's configured
  // business hours. A fixture without hours must not advertise free slots.
  await pool.query(
    `INSERT INTO business_hours (workspace_id, day_of_week, enabled, open_time, close_time)
     SELECT $1, n, true, '08:00', '19:00' FROM generate_series(0, 6) n
     ON CONFLICT (workspace_id, day_of_week) DO UPDATE
       SET enabled = true, open_time = '08:00', close_time = '19:00', updated_at = now()`,
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
    `INSERT INTO credit_wallets (workspace_id, balance) VALUES ($1, 5000)
     ON CONFLICT (workspace_id) DO UPDATE SET balance = 5000, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO hosted_api_rate_cards
       (capability, provider, model, unit, cost_micros, units_per_cost, target_margin_bps, effective_from, metadata)
     VALUES ('SMS', 'telnyx', '', 'SMS_SEGMENT', 450, 1, 5000, now(), '{"fixture":"milestone5"}'::jsonb)`,
  );
  const calendarIntegration = await pool.query(
    `INSERT INTO integrations (workspace_id, category, provider, mode, status, settings)
     VALUES ($1, 'CALENDAR', 'calcom', 'BYOP', 'CONNECTED', '{}'::jsonb)
     RETURNING id`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO capability_bindings (workspace_id, capability, integration_id, mode)
     VALUES ($1, 'CALENDAR', $2, 'BYOP')
     ON CONFLICT (workspace_id, capability) DO UPDATE SET integration_id = EXCLUDED.integration_id, mode = EXCLUDED.mode, updated_at = now()`,
    [workspaceId, calendarIntegration.rows[0].id],
  );
  const hostedCommunicationSettings = {
    voice: { mode: "HOSTED", provider: null, numberMode: "new", number: "+12025550200" },
    sms: { mode: "HOSTED", provider: null, numberMode: "same", number: "+12025550200", displayName: "Milestone Five Auto Spa", replyWindow: "Always respond", afterHoursBehavior: "Auto-reply + collect details" },
    whatsapp: { mode: "BYOP", provider: "whatsapp", accountMode: "existing" },
    webchat: { enabled: true },
  };
  await pool.query(
    `INSERT INTO communication_setup_settings (workspace_id, settings)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
    [workspaceId, JSON.stringify(hostedCommunicationSettings)],
  );
  const search = await api(context, "GET", "/api/phone-numbers/search?country=US&areaCode=202&type=local", undefined, "search managed phone numbers");
  const availableNumber = search?.items?.find((item) => item.phoneNumber === "+12025550200");
  assert(availableNumber, "Managed-number search did not return the guarded Telnyx fixture number.");

  const provisionRequestId = randomUUID();
  const provisioned = await api(context, "POST", "/api/phone-numbers", {
    phoneNumber: availableNumber.phoneNumber,
    requestId: provisionRequestId,
    expectedPurchaseCredits: availableNumber.purchaseCredits,
    expectedMonthlyCredits: availableNumber.monthlyCredits,
    replaceCurrent: false,
  }, "provision managed phone number");
  assert(provisioned?.number?.status === "ACTIVE", `Managed number did not reach ACTIVE after carrier reconciliation: ${JSON.stringify(provisioned?.number)}`);
  assert(provisioned?.number?.messagingReadiness === "NOT_REGISTERED", "Fresh managed number incorrectly reported outbound SMS as ready.");

  const provisionedRow = await pool.query(
    `SELECT status, provider_order_id, provider_order_phone_number_id, provider_order_status,
            provider_number_id, messaging_readiness
       FROM hosted_phone_numbers WHERE workspace_id = $1 AND provision_request_id = $2 LIMIT 1`,
    [workspaceId, provisionRequestId],
  );
  assert(provisionedRow.rows[0]?.status === "ACTIVE", "Provisioning lifecycle did not persist ACTIVE after the ordered number and owned inventory became usable.");
  assert(provisionedRow.rows[0]?.provider_order_status === "pending", "Documented Telnyx parent-order status was not persisted while the individual number finalized.");
  assert(Boolean(provisionedRow.rows[0]?.provider_order_phone_number_id), "Telnyx order-phone-number id was not persisted separately.");
  assert(Boolean(provisionedRow.rows[0]?.provider_number_id), "Owned Telnyx phone-number id was not reconciled.");

  await page.goto(`${baseUrl}/setup/communication`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Phone & SMS/ }).waitFor();
  await page.getByText("+1 (202) 555-0200", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText("Registration required", { exact: true }).waitFor();
  await assertNoHorizontalOverflow(page, "Managed phone and SMS setup desktop");
  await page.goto(`${baseUrl}/settings?tab=phone#sms-registration`, { waitUntil: "networkidle" });
  await page.getByText("Activate SMS messaging", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "SMS registration" }).waitFor();
  await page.getByText(/Register \+12025550200 for US 10DLC messaging/).waitFor();
  await page.getByRole("button", { name: "Save registration draft" }).waitFor();
  await assertNoHorizontalOverflow(page, "Not-started SMS registration settings");
  await page.screenshot({ path: path.join(outputDir, "sms-registration-not-started-desktop.png"), fullPage: true });

  // Exercise every optional registration UI state without calling the live carrier.
  // The DB fixture represents externally observed states; it does not prove approval.
  await pool.query(
    `INSERT INTO sms_registrations (workspace_id, phone_number_id, number_type, status, draft)
       SELECT $1, id, 'local', 'PENDING', '{}'::jsonb
       FROM hosted_phone_numbers WHERE workspace_id = $1 AND provision_request_id = $2`,
    [workspaceId, provisionRequestId],
  );
  await pool.query(
    `UPDATE hosted_phone_numbers SET messaging_readiness = 'PENDING', updated_at = now()
      WHERE workspace_id = $1 AND provision_request_id = $2`,
    [workspaceId, provisionRequestId],
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("SMS registration pending", { exact: true }).waitFor();
  await page.getByRole("link", { name: /View status/ }).click();
  await page.getByRole("heading", { name: "SMS registration" }).waitFor();
  await page.getByText(/Your submission is being reviewed/).waitFor();
  await assertNoHorizontalOverflow(page, "Pending SMS registration settings");
  await page.screenshot({ path: path.join(outputDir, "sms-registration-pending-desktop.png"), fullPage: true });

  await pool.query(
    `UPDATE sms_registrations SET status = 'REJECTED',
       rejection_reason = 'Carrier rejected missing opt-in evidence.', updated_at = now()
      WHERE workspace_id = $1 AND phone_number_id IN (
        SELECT id FROM hosted_phone_numbers WHERE workspace_id = $1 AND provision_request_id = $2
      )`,
    [workspaceId, provisionRequestId],
  );
  await pool.query(
    `UPDATE hosted_phone_numbers SET messaging_readiness = 'REJECTED', updated_at = now()
      WHERE workspace_id = $1 AND provision_request_id = $2`,
    [workspaceId, provisionRequestId],
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("SMS registration needs attention", { exact: true }).waitFor();
  await page.getByText("Carrier response: Carrier rejected missing opt-in evidence.").waitFor();
  await page.getByRole("button", { name: "Save registration draft" }).waitFor();
  await assertNoHorizontalOverflow(page, "Rejected SMS registration settings");
  await page.screenshot({ path: path.join(outputDir, "sms-registration-rejected-desktop.png"), fullPage: true });

  await pool.query(
    `UPDATE hosted_phone_numbers SET messaging_readiness = 'READY', updated_at = now()
      WHERE workspace_id = $1 AND provision_request_id = $2`,
    [workspaceId, provisionRequestId],
  );
  // Guarded CI carrier fixture: both readiness and approved-policy records are required.
  await pool.query(
    `UPDATE sms_registrations SET status = 'READY', rejection_reason = NULL,
       approved_policy = '{"categories":["TRANSACTIONAL"],"allowEmbeddedLinks":true,"description":"Appointment replies"}'::jsonb,
       updated_at = now()
      WHERE workspace_id = $1 AND phone_number_id IN (
        SELECT id FROM hosted_phone_numbers WHERE workspace_id = $1 AND provision_request_id = $2
      )`,
    [workspaceId, provisionRequestId],
  );
  await page.goto(`${baseUrl}/setup/communication`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: path.join(outputDir, "sms-managed-setup-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page, "Managed phone and SMS setup mobile");
  await page.screenshot({ path: path.join(outputDir, "sms-managed-setup-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const invalid = await sendTelnyxWebhook(workspaceId, telnyxEvent(
    "message.received",
    "evt-invalid-signature",
    {
      id: "SM-invalid-signature",
      from: { phone_number: "+12025550100" },
      to: [{ phone_number: "+12025550200" }],
      text: "Should be rejected",
    },
  ), false);
  assert(invalid.response.status === 401, `Expected invalid SMS signature to return 401, received ${invalid.response.status}.`);

  const turns = [
    { sid: "SM-m5-1", body: "How much is the QA Consultation?",
      expectedPattern: "QA Consultation is $120. I can also check tomorrow's availability.",
      expectedContains: "QA Consultation is $120" },
    { sid: "SM-m5-2", body: "What times are available tomorrow?",
      expectedPattern: "%I checked the schedule. Available times include%10:00 AM%",
      expectedContains: "I checked the schedule. Available times include" },
    { sid: "SM-m5-3", body: "My name is SMS Visitor, sms.visitor@example.com. Book the 10:00 AM slot",
      expectedPattern: "%Would you like me to book it?%",
      expectedContains: "Would you like me to book it?" },
    { sid: "SM-m5-4", body: "Yes, please.",
      expectedPattern: "%Your QA Consultation is booked for%10:00 AM%",
      expectedContains: "Your QA Consultation is booked for" },
  ];

  let conversationId;
  for (const turn of turns) {
    const webhook = await sendTelnyxWebhook(workspaceId, telnyxEvent("message.received", `evt-${turn.sid}-received`, {
      id: turn.sid,
      from: { phone_number: "+12025550100" },
      to: [{ phone_number: "+12025550200" }],
      text: turn.body,
    }));
    assert(webhook.response.status === 202, `Expected Telnyx SMS webhook 202 for ${turn.sid}, received ${webhook.response.status}: ${webhook.text}`);
    assert(webhook.payload?.queued === 1, `Expected ${turn.sid} to queue one SMS response.`);

    const result = await waitFor(
      pool,
      `SELECT c.id AS conversation_id, m.body, m.external_message_id, m.status
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.workspace_id = $1 AND m.channel = 'SMS' AND m.direction = 'OUTBOUND' AND m.body LIKE $2
        ORDER BY m.created_at DESC LIMIT 1`,
      [workspaceId, turn.expectedPattern],
      (rows) => rows.rowCount === 1 && Boolean(rows.rows[0].external_message_id),
      `outbound SMS for ${turn.sid}`,
    );
    conversationId = result.rows[0].conversation_id;

    if (turn.sid === "SM-m5-3") {
      const preConfirmationBooking = await pool.query(
        `SELECT count(*)::int AS count FROM appointments WHERE workspace_id = $1`,
        [workspaceId],
      );
      assert(preConfirmationBooking.rows[0].count === 0,
        "SMS booking executed before explicit customer confirmation.");
      const stagedAction = await pool.query(
        `SELECT status FROM pending_agent_actions
          WHERE workspace_id = $1 AND conversation_id = $2 AND type = 'BOOK_APPOINTMENT'
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, conversationId],
      );
      assert(stagedAction.rows[0]?.status === "AWAITING_CONFIRMATION",
        "SMS booking proposal was not persisted as awaiting confirmation.");
    }
  }
  assert(conversationId, "SMS flow did not create a conversation.");

  const duplicate = await sendTelnyxWebhook(workspaceId, telnyxEvent("message.received", "evt-SM-m5-4-received", {
    id: "SM-m5-4",
    from: { phone_number: "+12025550100" },
    to: [{ phone_number: "+12025550200" }],
    text: turns[3].body,
  }));
  assert(duplicate.response.status === 202, "Duplicate SMS webhook was not safely acknowledged.");
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
    assert(timeline.rows.some((row) => row.channel === "SMS" && row.direction === "OUTBOUND" && row.body.includes(turn.expectedContains)), `SMS timeline is missing outbound containing: ${turn.expectedContains}`);
  }
  assert(timeline.rows.some((row) => row.channel === "SMS" && row.content_type === "APPOINTMENT_EVENT" && row.body === "Appointment booked: QA Consultation"), "SMS appointment event was not attributed to SMS.");
  assert(timeline.rows.length === messageCountAfterDuplicate, "Duplicate inbound webhook added another timeline item.");

  const lastOutbound = [...timeline.rows].reverse().find((row) => row.direction === "OUTBOUND");
  assert(lastOutbound?.external_message_id, "SMS outbound provider message id was not persisted.");
  const delivery = await sendTelnyxWebhook(workspaceId, telnyxEvent("message.finalized", "evt-m5-delivered", {
    id: lastOutbound.external_message_id,
    to: [{ phone_number: "+12025550100", status: "delivered" }],
    errors: [],
  }));
  assert(delivery.response.status === 202, `Delivery callback failed with ${delivery.response.status}: ${delivery.text}`);
  await waitFor(
    pool,
    `SELECT status FROM messages WHERE workspace_id = $1 AND provider = 'telnyx' AND external_message_id = $2 LIMIT 1`,
    [workspaceId, lastOutbound.external_message_id],
    (rows) => rows.rows[0]?.status === "DELIVERED",
    "SMS delivery status",
  );

  const smsUsage = await pool.query(`SELECT mode, provider, credits_charged FROM usage_events WHERE workspace_id = $1 AND capability = 'SMS' ORDER BY created_at`, [workspaceId]);
  assert(smsUsage.rowCount === 8, `Expected 8 hosted SMS usage events (4 inbound + 4 outbound), received ${smsUsage.rowCount}.`);
  assert(smsUsage.rows.every((row) => row.mode === "HOSTED" && row.provider === "telnyx" && row.credits_charged === 1), "Hosted SMS usage attribution/credits are incorrect.");

  const balance = (await pool.query(`SELECT balance FROM credit_wallets WHERE workspace_id = $1`, [workspaceId])).rows[0].balance;
  const charged = (await pool.query(
    `SELECT coalesce(sum(credits_charged), 0)::int AS credits
       FROM usage_events WHERE workspace_id = $1`,
    [workspaceId],
  )).rows[0].credits;
  assert(balance === 5000 - charged,
    `Credit wallet is inconsistent with metered usage: expected ${5000 - charged}, received ${balance}.`);

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
  await page.getByText("How much is the QA Consultation?", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("Appointment booked: QA Consultation", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("SMS Visitor", { exact: true }).first().waitFor({ timeout: 15_000 });
  await assertNoHorizontalOverflow(page, "Inbox after SMS booking");
  await page.screenshot({ path: path.join(outputDir, "inbox-sms-desktop.png"), fullPage: true });

  const outboundBeforeHuman = (await pool.query(`SELECT count(*)::int AS count FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'OUTBOUND'`, [workspaceId, conversationId])).rows[0].count;
  await pool.query(`UPDATE conversations SET handling_mode = 'HUMAN', ai_paused_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2`, [workspaceId, conversationId]);
  const humanWebhook = await sendTelnyxWebhook(workspaceId, telnyxEvent("message.received", "evt-SM-m5-human-received", {
    id: "SM-m5-human",
    from: { phone_number: "+12025550100" },
    to: [{ phone_number: "+12025550200" }],
    text: "A human is helping me now",
  }));
  assert(humanWebhook.response.status === 202 && humanWebhook.payload?.queued === 1, "Human-mode inbound SMS was not safely queued/persisted.");
  await waitFor(
    pool,
    `SELECT status FROM provider_webhook_events WHERE workspace_id = $1 AND provider = 'telnyx' AND external_event_id = 'evt-SM-m5-human-received' LIMIT 1`,
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
  console.log("Milestone 5 browser acceptance passed: managed Telnyx search/order/pending-to-final activation lifecycle, outbound-SMS readiness gating, signed SMS webhooks, async worker, knowledge response, contact capture, qualification, availability, booking, hosted credit metering, duplicate suppression, delivery reconciliation, unified Inbox, and human takeover suppression.");
} finally {
  await pool.end();
  await browser.close();
}

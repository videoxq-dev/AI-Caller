import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 8 browser verification.");
if (!encryptionKey) throw new Error("INTEGRATION_ENCRYPTION_KEY is required for Milestone 8 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "milestone8-browser");
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

async function waitFor(pool, query, values, predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await pool.query(query, values);
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
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

async function createTextConversation(pool, {
  workspaceId,
  name,
  channel,
  identity,
  body,
  createdAt = new Date(),
}) {
  const contact = await pool.query(
    `INSERT INTO contacts (workspace_id, name, phone) VALUES ($1, $2, $3) RETURNING id`,
    [workspaceId, name, channel === "SMS" || channel === "WHATSAPP" ? identity : null],
  );
  await pool.query(
    `INSERT INTO contact_identities (workspace_id, contact_id, channel, external_id, normalized_value)
     VALUES ($1, $2, $3, $4, $4)`,
    [workspaceId, contact.rows[0].id, channel, identity],
  );
  const conversation = await pool.query(
    `INSERT INTO conversations (workspace_id, contact_id, handling_mode, last_message_at)
     VALUES ($1, $2, 'AI', $3) RETURNING id`,
    [workspaceId, contact.rows[0].id, createdAt],
  );
  const metadata = channel === "WHATSAPP" ? { occurredAt: createdAt.toISOString() } : {};
  await pool.query(
    `INSERT INTO messages (workspace_id, conversation_id, channel, direction, sender_type, content_type, body, provider, external_message_id, status, metadata, created_at)
     VALUES ($1, $2, $3, 'INBOUND', 'CUSTOMER', 'TEXT', $4, $5, $6, 'RECEIVED', $7::jsonb, $8)`,
    [
      workspaceId,
      conversation.rows[0].id,
      channel,
      body,
      channel === "WHATSAPP" ? "whatsapp" : channel === "SMS" ? "fixture-sms" : "webchat-customer",
      `m8-${channel.toLowerCase()}-${randomUUID()}`,
      JSON.stringify(metadata),
      createdAt,
    ],
  );
  return { contactId: contact.rows[0].id, conversationId: conversation.rows[0].id };
}

const browser = await chromium.launch({ headless: true });
const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const staffContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const widgetContext = await browser.newContext({ viewport: { width: 430, height: 760 } });
const ownerPage = await ownerContext.newPage();
const staffPage = await staffContext.newPage();
const widgetPage = await widgetContext.newPage();
const runtimeErrors = [];

for (const page of [ownerPage, staffPage, widgetPage]) {
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) runtimeErrors.push(`HTTP ${response.status()} ${response.url()}`);
  });
}

const stamp = Date.now();
const ownerEmail = `milestone8-owner-${stamp}@example.com`;
const staffEmail = `milestone8-staff-${stamp}@example.com`;
const password = "BrowserSmokePass123!";
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  await api(ownerContext, "POST", "/api/auth/sign-up/email", {
    name: "Milestone Eight Owner",
    email: ownerEmail,
    password,
  }, "owner sign up");

  const ownerRow = await waitFor(
    pool,
    `SELECT u.id AS user_id, m.workspace_id
       FROM "user" u JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'
      ORDER BY m.created_at LIMIT 1`,
    [ownerEmail],
    (rows) => rows.rowCount === 1,
    "owner workspace provisioning",
  );
  const ownerUserId = ownerRow.rows[0].user_id;
  const workspaceId = ownerRow.rows[0].workspace_id;

  await pool.query(`UPDATE workspaces SET name = 'Milestone Eight Workspace' WHERE id = $1`, [workspaceId]);
  await pool.query(
    `INSERT INTO workspace_plans (workspace_id, plan_id, source)
     VALUES ($1, 'GROWTH', 'E2E')
     ON CONFLICT (workspace_id) DO UPDATE SET plan_id = 'GROWTH', source = 'E2E', updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO business_profiles (workspace_id, business_name, industry, timezone, summary)
     VALUES ($1, 'Milestone Eight Studio', 'Professional services', 'UTC', 'M8 collaboration and automation verification.')
     ON CONFLICT (workspace_id) DO UPDATE SET business_name = EXCLUDED.business_name, timezone = EXCLUDED.timezone, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO credit_wallets (workspace_id, balance) VALUES ($1, 100)
     ON CONFLICT (workspace_id) DO UPDATE SET balance = 100, updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO hosted_api_rate_cards
       (capability, provider, model, unit, cost_micros, units_per_cost, target_margin_bps, effective_from, metadata)
     VALUES ('SMS', 'telnyx', '', 'SMS_SEGMENT', 450, 1, 5000, now(), '{"fixture":"milestone8"}'::jsonb)`,
  );

  const communicationSettings = {
    voice: { mode: "HOSTED", provider: null, numberMode: "new", number: "+12025550800" },
    sms: { mode: "HOSTED", provider: null, numberMode: "same", number: "+12025550800", displayName: "Milestone Eight Studio", replyWindow: "Always respond", afterHoursBehavior: "Auto-reply + collect details" },
    whatsapp: { mode: "BYOP", provider: "whatsapp", accountMode: "existing" },
    webchat: { enabled: true },
  };
  await pool.query(
    `INSERT INTO communication_setup_settings (workspace_id, settings)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
    [workspaceId, JSON.stringify(communicationSettings)],
  );
  await pool.query(
    `INSERT INTO capability_bindings (workspace_id, capability, integration_id, mode)
     VALUES ($1, 'SMS', NULL, 'HOSTED')
     ON CONFLICT (workspace_id, capability) DO UPDATE SET integration_id = NULL, mode = 'HOSTED', updated_at = now()`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO hosted_phone_numbers
       (workspace_id, provider, provider_number_id, phone_number, country_code, number_type, status,
        provider_monthly_cost_micros, provider_upfront_cost_micros, monthly_credits, purchase_credits,
        current_period_start, current_period_end, next_billing_at)
     VALUES ($1, 'telnyx', 'm8-managed-number', '+12025550800', 'US', 'local', 'ACTIVE',
       1000000, 0, 2000, 2000, now(), now() + interval '30 days', now() + interval '30 days')`,
    [workspaceId],
  );

  const phoneNumberId = `phone-m8-${stamp}`;
  const waCredentials = encryptCredentials({
    accessToken: "ci-meta-access-token",
    wabaId: "waba-m8",
    phoneNumberId,
  });
  const waIntegration = await pool.query(
    `INSERT INTO integrations (workspace_id, category, provider, mode, status, encrypted_credentials, settings)
     VALUES ($1, 'WHATSAPP', 'whatsapp', 'BYOP', 'CONNECTED', $2::jsonb, $3::jsonb)
     RETURNING id`,
    [workspaceId, JSON.stringify(waCredentials), JSON.stringify({
      authMethod: "EMBEDDED_SIGNUP",
      wabaId: "waba-m8",
      phoneNumberId,
      displayPhoneNumber: "+12025550801",
      verifiedName: "Milestone Eight Studio",
      webhookSubscribed: true,
    })],
  );
  await pool.query(
    `INSERT INTO capability_bindings (workspace_id, capability, integration_id, mode)
     VALUES ($1, 'WHATSAPP', $2, 'BYOP')
     ON CONFLICT (workspace_id, capability) DO UPDATE SET integration_id = EXCLUDED.integration_id, mode = 'BYOP', updated_at = now()`,
    [workspaceId, waIntegration.rows[0].id],
  );

  const widgetKey = `wc_m8_${randomBytes(12).toString("base64url")}`;
  await pool.query(
    `INSERT INTO webchat_widgets (workspace_id, public_key, enabled, greeting, launcher_label)
     VALUES ($1, $2, true, 'Hi from Milestone Eight.', 'Chat with us')
     ON CONFLICT (workspace_id) DO UPDATE SET public_key = EXCLUDED.public_key, enabled = true, greeting = EXCLUDED.greeting, updated_at = now()`,
    [workspaceId, widgetKey],
  );

  const invite = await api(ownerContext, "POST", "/api/team/invitations", {
    email: staffEmail,
    role: "STAFF",
  }, "create staff invitation");
  assert(invite.data?.e2eToken, "Guarded M8 invitation response did not include the CI-only acceptance token.");
  const invitationToken = invite.data.e2eToken;

  const pendingInvite = await pool.query(
    `SELECT status, role, token_hash FROM workspace_invitations WHERE workspace_id = $1 AND email = $2 LIMIT 1`,
    [workspaceId, staffEmail],
  );
  assert(pendingInvite.rows[0]?.status === "PENDING", "Team invitation was not persisted as PENDING.");
  assert(pendingInvite.rows[0]?.role === "STAFF", "Team invitation role was not persisted.");
  assert(pendingInvite.rows[0]?.token_hash && pendingInvite.rows[0].token_hash !== invitationToken, "Plain invitation token was persisted instead of a hash.");

  await api(staffContext, "POST", "/api/auth/sign-up/email", {
    name: "Milestone Eight Staff",
    email: staffEmail,
    password,
  }, "staff sign up");

  const staffRow = await waitFor(
    pool,
    `SELECT u.id AS user_id, m.workspace_id
       FROM "user" u JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'
      ORDER BY m.created_at LIMIT 1`,
    [staffEmail],
    (rows) => rows.rowCount === 1,
    "staff default workspace provisioning",
  );
  const staffUserId = staffRow.rows[0].user_id;
  const staffDefaultWorkspaceId = staffRow.rows[0].workspace_id;

  const accepted = await api(staffContext, "POST", "/api/team/invitations/accept", { token: invitationToken }, "accept staff invitation");
  assert(accepted.data?.membership?.workspaceId === workspaceId, "Invitation acceptance did not return the invited workspace.");
  assert(accepted.data?.membership?.role === "STAFF", "Invitation acceptance did not create the Staff role.");
  await api(staffContext, "POST", "/api/team/invitations/accept", { token: invitationToken }, "reject reused invitation token", 400);

  const staffWorkspaces = await api(staffContext, "GET", "/api/workspaces", undefined, "load staff workspaces");
  assert(staffWorkspaces.data?.workspaces?.length >= 2, "Invited staff member did not retain both workspace memberships.");
  assert(staffWorkspaces.data?.activeWorkspaceId === workspaceId, "Accepting the invitation did not select the invited workspace.");
  await api(staffContext, "POST", "/api/workspaces", { workspaceId: staffDefaultWorkspaceId }, "switch to staff default workspace");
  const switchedAway = await api(staffContext, "GET", "/api/workspaces", undefined, "verify default workspace switch");
  assert(switchedAway.data?.activeWorkspaceId === staffDefaultWorkspaceId, "Active workspace did not switch to the staff default workspace.");
  await api(staffContext, "POST", "/api/workspaces", { workspaceId }, "switch back to invited workspace");

  const team = await api(ownerContext, "GET", "/api/team", undefined, "load owner team");
  assert(team.data?.members?.some((member) => member.userId === staffUserId && member.role === "STAFF"), "Owner team roster does not contain the accepted Staff member.");

  const sms = await createTextConversation(pool, {
    workspaceId,
    name: "M8 SMS Customer",
    channel: "SMS",
    identity: "+12025550810",
    body: "I need help by text.",
  });
  const whatsapp = await createTextConversation(pool, {
    workspaceId,
    name: "M8 WhatsApp Customer",
    channel: "WHATSAPP",
    identity: "+15551238011",
    body: "I need a team member.",
  });

  await widgetPage.goto(`${baseUrl}/widget/${widgetKey}`, { waitUntil: "networkidle" });
  await widgetPage.getByPlaceholder("Type your message…").waitFor({ timeout: 10_000 });
  const webchatSession = await waitFor(
    pool,
    `SELECT contact_id, conversation_id FROM webchat_sessions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
    (rows) => rows.rowCount === 1,
    "Web Chat session creation",
  );
  const webchatContactId = webchatSession.rows[0].contact_id;
  const webchatConversationId = webchatSession.rows[0].conversation_id;
  await pool.query(
    `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
    [webchatConversationId],
  );
  await pool.query(
    `INSERT INTO messages (workspace_id, conversation_id, channel, direction, sender_type, content_type, body, provider, external_message_id, status)
     VALUES ($1, $2, 'WEBCHAT', 'INBOUND', 'CUSTOMER', 'TEXT', 'Please connect me with the team.', 'webchat-customer', $3, 'RECEIVED')`,
    [workspaceId, webchatConversationId, `m8-webchat-${randomUUID()}`],
  );

  await api(ownerContext, "PUT", `/api/conversations/${whatsapp.conversationId}/assignment`, { assignedUserId: staffUserId }, "owner assigns WhatsApp conversation");
  const staffNotices = await api(staffContext, "GET", "/api/notifications?limit=20", undefined, "load staff notifications");
  const assignmentNotice = staffNotices.data?.items?.find((item) => item.type === "CONVERSATION_ASSIGNED" && item.conversationId === whatsapp.conversationId);
  assert(assignmentNotice && !assignmentNotice.readAt, "Conversation assignment did not create an unread staff notification.");

  await api(staffContext, "PUT", `/api/conversations/${whatsapp.conversationId}/assignment`, { assignedUserId: ownerUserId }, "staff cannot assign another member", 403);

  await api(staffContext, "PUT", `/api/conversations/${sms.conversationId}/handling`, { mode: "HUMAN", assignedUserId: staffUserId }, "staff takes over SMS");
  const staffSms = await api(staffContext, "POST", `/api/conversations/${sms.conversationId}/sms-reply`, { text: "M8 staff SMS reply." }, "staff SMS reply");
  assert(staffSms.data?.message?.senderType === "USER", "Staff SMS reply was not persisted as USER.");
  assert(String(staffSms.data?.message?.externalMessageId ?? "").startsWith("e2e-sms-"), "Staff SMS reply did not use the provider fixture.");

  await api(staffContext, "PUT", `/api/conversations/${whatsapp.conversationId}/handling`, { mode: "HUMAN", assignedUserId: staffUserId }, "staff takes over WhatsApp");
  const staffWa = await api(staffContext, "POST", `/api/conversations/${whatsapp.conversationId}/whatsapp-reply`, { text: "M8 staff WhatsApp reply." }, "staff WhatsApp reply");
  assert(staffWa.data?.message?.senderType === "USER", "Staff WhatsApp reply was not persisted as USER.");
  assert(String(staffWa.data?.message?.externalMessageId ?? "").startsWith("e2e-wa-"), "Staff WhatsApp reply did not use the provider fixture.");

  await api(staffContext, "PUT", `/api/conversations/${webchatConversationId}/handling`, { mode: "HUMAN", assignedUserId: staffUserId }, "staff takes over Web Chat");
  const staffWebchat = await api(staffContext, "POST", `/api/conversations/${webchatConversationId}/webchat-reply`, { text: "M8 Web Chat human reply." }, "staff Web Chat reply");
  assert(staffWebchat.data?.message?.senderType === "USER" && staffWebchat.data?.message?.status === "DELIVERED", "Staff Web Chat reply was not delivered into the conversation.");
  await widgetPage.getByText("M8 Web Chat human reply.", { exact: true }).waitFor({ timeout: 12_000 });

  await api(staffContext, "POST", `/api/notifications/${assignmentNotice.id}/read`, undefined, "mark assignment notification read");
  const readNotice = await pool.query(`SELECT read_at FROM notifications WHERE id = $1`, [assignmentNotice.id]);
  assert(readNotice.rows[0]?.read_at, "Notification read state was not persisted.");

  await api(staffContext, "PUT", `/api/conversations/${sms.conversationId}/handling`, { mode: "AI" }, "return SMS conversation to AI");
  const handlingAudit = await pool.query(
    `SELECT type, actor_user_id, assigned_user_id FROM conversation_handling_events WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at`,
    [workspaceId, sms.conversationId],
  );
  assert(handlingAudit.rows.some((row) => row.type === "TAKEOVER" && row.actor_user_id === staffUserId), "SMS takeover was not audited.");
  assert(handlingAudit.rows.some((row) => row.type === "RETURN_TO_AI" && row.actor_user_id === staffUserId), "Return-to-AI was not audited.");

  const automationConfigs = [
    ["MISSED_INQUIRY_RECOVERY", { delayMinutes: 5, channels: ["SMS"], message: "M8 missed inquiry recovery for {{name}}." }],
    ["QUALIFIED_LEAD_ASSIGNMENT", { assignedUserId: staffUserId, notifyInApp: true }],
    ["APPOINTMENT_CONFIRMATION", { channels: ["SMS"], message: "M8 confirmation for {{name}} at {{appointment_time}}." }],
    ["APPOINTMENT_REMINDER", { firstMinutesBefore: 15, secondMinutesBefore: null, channels: ["SMS"], message: "M8 reminder for {{name}} at {{appointment_time}}." }],
    ["HUMAN_ESCALATION", { assignedUserId: staffUserId, notifyInApp: true }],
  ];
  for (const [key, config] of automationConfigs) {
    await api(ownerContext, "PATCH", `/api/automations/${key}`, { enabled: true, config }, `enable ${key}`);
  }
  await api(staffContext, "PATCH", "/api/automations/HUMAN_ESCALATION", {
    enabled: false,
    config: { assignedUserId: null, notifyInApp: true },
  }, "staff cannot edit automations", 403);

  const past = new Date(Date.now() - 10 * 60_000);
  const missed = await createTextConversation(pool, {
    workspaceId,
    name: "M8 Missed Inquiry",
    channel: "SMS",
    identity: "+12025550820",
    body: "Did anyone see this?",
    createdAt: past,
  });
  await pool.query(
    `INSERT INTO automation_events (workspace_id, type, aggregate_type, aggregate_id, payload, occurred_at)
     VALUES ($1, 'INQUIRY_RECEIVED', 'MESSAGE', $2, $3::jsonb, $4)`,
    [workspaceId, randomUUID(), JSON.stringify({
      conversationId: missed.conversationId,
      contactId: missed.contactId,
      channel: "SMS",
      receivedAt: past.toISOString(),
    }), past],
  );
  await waitFor(
    pool,
    `SELECT m.id
       FROM messages m
      WHERE m.workspace_id = $1 AND m.conversation_id = $2 AND m.sender_type = 'SYSTEM' AND m.body = $3
      LIMIT 1`,
    [workspaceId, missed.conversationId, "M8 missed inquiry recovery for M8 Missed Inquiry."],
    (rows) => rows.rowCount === 1,
    "missed inquiry recovery delivery",
  );
  await waitFor(
    pool,
    `SELECT r.status, count(d.id)::int AS deliveries
       FROM automation_runs r LEFT JOIN automation_deliveries d ON d.run_id = r.id
      WHERE r.workspace_id = $1 AND r.key = 'MISSED_INQUIRY_RECOVERY'
      GROUP BY r.id ORDER BY r.created_at DESC LIMIT 1`,
    [workspaceId],
    (rows) => rows.rows[0]?.status === "COMPLETED" && rows.rows[0]?.deliveries === 1,
    "missed inquiry automation completion",
  );

  const qualifiedContact = await pool.query(
    `INSERT INTO contacts (workspace_id, name, phone) VALUES ($1, 'M8 Qualified Lead', '+12025550830') RETURNING id`,
    [workspaceId],
  );
  const qualifiedConversation = await pool.query(
    `INSERT INTO conversations (workspace_id, contact_id, last_message_at) VALUES ($1, $2, now()) RETURNING id`,
    [workspaceId, qualifiedContact.rows[0].id],
  );
  const qualifiedLead = await pool.query(
    `INSERT INTO leads (workspace_id, contact_id, status, source, qualification_score, qualification_completed_at)
     VALUES ($1, $2, 'QUALIFIED', 'SMS', 100, now()) RETURNING id`,
    [workspaceId, qualifiedContact.rows[0].id],
  );
  await pool.query(
    `INSERT INTO automation_events (workspace_id, type, aggregate_type, aggregate_id, payload)
     VALUES ($1, 'LEAD_QUALIFIED', 'LEAD', $2, $3::jsonb)`,
    [workspaceId, qualifiedLead.rows[0].id, JSON.stringify({
      leadId: qualifiedLead.rows[0].id,
      contactId: qualifiedContact.rows[0].id,
      qualificationScore: 100,
    })],
  );
  await waitFor(
    pool,
    `SELECT assigned_user_id FROM leads WHERE id = $1`,
    [qualifiedLead.rows[0].id],
    (rows) => rows.rows[0]?.assigned_user_id === staffUserId,
    "qualified lead automatic assignment",
  );
  const assignedQualifiedConversation = await pool.query(`SELECT assigned_user_id FROM conversations WHERE id = $1`, [qualifiedConversation.rows[0].id]);
  assert(assignedQualifiedConversation.rows[0]?.assigned_user_id === staffUserId, "Qualified lead automation did not assign the open conversation.");

  const appointmentContact = await pool.query(
    `INSERT INTO contacts (workspace_id, name, phone) VALUES ($1, 'M8 Appointment Customer', '+12025550840') RETURNING id`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO contact_identities (workspace_id, contact_id, channel, external_id, normalized_value)
     VALUES ($1, $2, 'SMS', '+12025550840', '+12025550840')`,
    [workspaceId, appointmentContact.rows[0].id],
  );
  const appointmentConversation = await pool.query(
    `INSERT INTO conversations (workspace_id, contact_id, last_message_at) VALUES ($1, $2, now()) RETURNING id`,
    [workspaceId, appointmentContact.rows[0].id],
  );
  const appointmentStart = new Date(Date.now() + 10 * 60_000);
  const appointmentEnd = new Date(appointmentStart.getTime() + 30 * 60_000);
  const appointment = await pool.query(
    `INSERT INTO appointments (workspace_id, contact_id, conversation_id, title, starts_at, ends_at, timezone, status, booking_source)
     VALUES ($1, $2, $3, 'M8 Consultation', $4, $5, 'UTC', 'CONFIRMED', 'M8_ACCEPTANCE')
     RETURNING id`,
    [workspaceId, appointmentContact.rows[0].id, appointmentConversation.rows[0].id, appointmentStart, appointmentEnd],
  );
  await pool.query(
    `INSERT INTO automation_events (workspace_id, type, aggregate_type, aggregate_id, payload)
     VALUES ($1, 'APPOINTMENT_CONFIRMED', 'APPOINTMENT', $2, $3::jsonb)`,
    [workspaceId, appointment.rows[0].id, JSON.stringify({
      appointmentId: appointment.rows[0].id,
      contactId: appointmentContact.rows[0].id,
      conversationId: appointmentConversation.rows[0].id,
      startsAt: appointmentStart.toISOString(),
    })],
  );

  await waitFor(
    pool,
    `SELECT count(*)::int AS count FROM messages
      WHERE workspace_id = $1 AND conversation_id = $2 AND sender_type = 'SYSTEM'
        AND (body LIKE 'M8 confirmation%' OR body LIKE 'M8 reminder%')`,
    [workspaceId, appointmentConversation.rows[0].id],
    (rows) => rows.rows[0]?.count === 2,
    "appointment confirmation and reminder deliveries",
  );
  await waitFor(
    pool,
    `SELECT key, status FROM automation_runs
      WHERE workspace_id = $1 AND event_id IN (
        SELECT id FROM automation_events WHERE workspace_id = $1 AND aggregate_id = $2
      )
      ORDER BY key`,
    [workspaceId, appointment.rows[0].id],
    (rows) => (
      rows.rows.some((row) => row.key === "APPOINTMENT_CONFIRMATION" && row.status === "COMPLETED")
      && rows.rows.some((row) => row.key === "APPOINTMENT_REMINDER" && row.status === "COMPLETED")
    ),
    "appointment automation run completion",
  );

  const staleAppointmentStart = new Date(Date.now() + 30 * 60_000);
  const staleAppointment = await pool.query(
    `INSERT INTO appointments (workspace_id, contact_id, conversation_id, title, starts_at, ends_at, timezone, status, booking_source)
     VALUES ($1, $2, $3, 'M8 Rescheduled Consultation', $4, $5, 'UTC', 'CONFIRMED', 'M8_ACCEPTANCE')
     RETURNING id`,
    [workspaceId, appointmentContact.rows[0].id, appointmentConversation.rows[0].id, staleAppointmentStart, new Date(staleAppointmentStart.getTime() + 30 * 60_000)],
  );
  const oldStart = new Date(Date.now() + 10 * 60_000);
  const staleEvent = await pool.query(
    `INSERT INTO automation_events (workspace_id, type, aggregate_type, aggregate_id, occurrence_key, payload)
     VALUES ($1, 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT', $2, $3, $4::jsonb)
     RETURNING id`,
    [workspaceId, staleAppointment.rows[0].id, oldStart.toISOString(), JSON.stringify({
      appointmentId: staleAppointment.rows[0].id,
      contactId: appointmentContact.rows[0].id,
      conversationId: appointmentConversation.rows[0].id,
      startsAt: oldStart.toISOString(),
    })],
  );
  await waitFor(
    pool,
    `SELECT status FROM automation_runs WHERE workspace_id = $1 AND event_id = $2 AND key = 'APPOINTMENT_REMINDER' LIMIT 1`,
    [workspaceId, staleEvent.rows[0].id],
    (rows) => rows.rows[0]?.status === "SKIPPED",
    "stale reminder suppression after reschedule",
  );

  const escalationContact = await pool.query(
    `INSERT INTO contacts (workspace_id, name) VALUES ($1, 'M8 Escalation Customer') RETURNING id`,
    [workspaceId],
  );
  const escalationConversation = await pool.query(
    `INSERT INTO conversations (workspace_id, contact_id, handling_mode, ai_paused_at, last_message_at)
     VALUES ($1, $2, 'HUMAN', now(), now()) RETURNING id`,
    [workspaceId, escalationContact.rows[0].id],
  );
  await pool.query(
    `INSERT INTO automation_events (workspace_id, type, aggregate_type, aggregate_id, payload)
     VALUES ($1, 'CONVERSATION_ESCALATED', 'HANDLING_EVENT', $2, $3::jsonb)`,
    [workspaceId, randomUUID(), JSON.stringify({
      conversationId: escalationConversation.rows[0].id,
      contactId: escalationContact.rows[0].id,
      reason: "Customer asked for a person",
    })],
  );
  await waitFor(
    pool,
    `SELECT assigned_user_id FROM conversations WHERE id = $1`,
    [escalationConversation.rows[0].id],
    (rows) => rows.rows[0]?.assigned_user_id === staffUserId,
    "human escalation automatic assignment",
  );

  await ownerPage.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
  await ownerPage.getByRole("button", { name: "Team", exact: true }).click();
  await ownerPage.getByText("Milestone Eight Staff", { exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(ownerPage, "Team settings desktop");
  await ownerPage.screenshot({ path: path.join(outputDir, "team-settings-desktop.png"), fullPage: true });

  await ownerPage.goto(`${baseUrl}/automations`, { waitUntil: "networkidle" });
  await ownerPage.getByRole("heading", { name: "Missed inquiry recovery", exact: true }).waitFor({ timeout: 10_000 });
  assert(await ownerPage.getByText("New lead response", { exact: true }).count() === 0, "Deprecated New lead response automation is still visible.");
  await ownerPage.getByRole("button", { name: "View activity log" }).click();
  await ownerPage.getByText("Qualified lead assignment", { exact: true }).first().waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(ownerPage, "Automations desktop");
  await ownerPage.screenshot({ path: path.join(outputDir, "automations-desktop.png"), fullPage: true });

  await staffPage.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await staffPage.getByLabel("Channel filter").selectOption("SMS");
  await staffPage.getByText("M8 SMS Customer", { exact: true }).first().click();
  await staffPage.getByText("M8 staff SMS reply.", { exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(staffPage, "Staff Inbox desktop");
  await staffPage.screenshot({ path: path.join(outputDir, "staff-inbox-desktop.png"), fullPage: true });

  await staffPage.goto(`${baseUrl}/automations`, { waitUntil: "networkidle" });
  await staffPage.getByText("View only · Owner/Admin can edit", { exact: true }).waitFor({ timeout: 10_000 });
  await staffPage.getByLabel("Active workspace").waitFor({ timeout: 10_000 });
  assert(await staffPage.getByLabel("Active workspace").inputValue() === workspaceId, "Shared navigation did not show the invited workspace as active.");

  await widgetPage.getByText("M8 Web Chat human reply.", { exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(widgetPage, "Web Chat human handoff widget");
  await widgetPage.screenshot({ path: path.join(outputDir, "webchat-human-reply.png"), fullPage: true });

  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.goto(`${baseUrl}/automations`, { waitUntil: "networkidle" });
  await ownerPage.getByRole("heading", { name: "Automations", exact: true }).waitFor({ timeout: 10_000 });
  await assertNoHorizontalOverflow(ownerPage, "Automations mobile");
  await ownerPage.screenshot({ path: path.join(outputDir, "automations-mobile.png"), fullPage: true });

  const activity = await api(ownerContext, "GET", "/api/automations/activity?limit=100", undefined, "load automation activity");
  const activityKeys = new Set((activity.data?.items ?? []).map((item) => item.run.key));
  for (const key of ["MISSED_INQUIRY_RECOVERY", "QUALIFIED_LEAD_ASSIGNMENT", "APPOINTMENT_CONFIRMATION", "APPOINTMENT_REMINDER", "HUMAN_ESCALATION"]) {
    assert(activityKeys.has(key), `Automation activity is missing ${key}.`);
  }

  const duplicateDeliveries = await pool.query(
    `SELECT run_id, channel, recipient, count(*)::int AS count
       FROM automation_deliveries
      WHERE workspace_id = $1
      GROUP BY run_id, channel, recipient
      HAVING count(*) > 1`,
    [workspaceId],
  );
  assert(duplicateDeliveries.rowCount === 0, "Automation delivery idempotency allowed duplicate run/channel/recipient rows.");

  assert(runtimeErrors.length === 0, `Browser/runtime errors detected: ${runtimeErrors.join(" | ")}`);
  console.log("Milestone 8 browser verification passed for team invitations, multi-workspace selection, RBAC, auditable takeover/assignment, persistent notifications, staff SMS/WhatsApp/Web Chat replies, durable predefined automations, worker recovery, reminder revalidation, activity logging, and responsive collaboration UI.");
} finally {
  await pool.end();
  await ownerContext.close();
  await staffContext.close();
  await widgetContext.close();
  await browser.close();
}

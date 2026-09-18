import { createCipheriv, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Milestone 7 browser verification.");
if (!encryptionKey) throw new Error("INTEGRATION_ENCRYPTION_KEY is required for Milestone 7 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "milestone7-browser");
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

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const webhookPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();

function telnyxSignature(timestamp, rawBody) {
  return sign(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), privateKey).toString("base64");
}

function eventPayload(eventType, id, callSessionId, callControlId, extra = {}) {
  return {
    data: {
      event_type: eventType,
      id,
      occurred_at: new Date().toISOString(),
      payload: {
        call_session_id: callSessionId,
        ...(callControlId ? { call_control_id: callControlId } : {}),
        ...extra,
      },
    },
  };
}

async function sendWebhook(workspaceId, payload, validSignature = true) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatureValue = validSignature ? telnyxSignature(timestamp, rawBody) : Buffer.alloc(64).toString("base64");
  const response = await fetch(`${baseUrl}/api/webhooks/voice/telnyx/${workspaceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": signatureValue,
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

const email = `milestone7-browser-${Date.now()}@example.com`;
await api(context, "POST", "/api/auth/sign-up/email", {
  name: "Milestone Seven QA",
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
  assert(workspaceId, "Default workspace was not created for the Milestone 7 browser user.");

  await pool.query(
    `INSERT INTO business_profiles (workspace_id, business_name, industry, timezone, summary)
     VALUES ($1, 'Milestone Seven Auto Spa', 'Auto detailing', 'UTC', 'A test business used to verify the inbound voice orchestrator flow.')
     ON CONFLICT (workspace_id) DO UPDATE SET business_name = EXCLUDED.business_name, industry = EXCLUDED.industry, timezone = EXCLUDED.timezone, summary = EXCLUDED.summary, updated_at = now()`,
    [workspaceId],
  );
  for (let day = 0; day < 7; day += 1) {
    await pool.query(
      `INSERT INTO business_hours (workspace_id, day_of_week, enabled, open_time, close_time)
       VALUES ($1, $2, true, '00:00', '00:00')
       ON CONFLICT (workspace_id, day_of_week) DO UPDATE SET enabled = true, open_time = '00:00', close_time = '00:00', updated_at = now()`,
      [workspaceId, day],
    );
  }

  const behaviorSettings = {
    guardrails: [
      "Never invent pricing",
      "Never confirm unavailable appointments",
      "Only answer based on approved business information",
    ],
    voice: {
      profileKey: "ava-us-1",
      language: "en-US",
      speakingRate: 1,
      recordingPolicy: "EXPLICIT_CONSENT",
      afterHoursEnabled: true,
    },
    qualification: {
      enabled: true,
      criteria: [
        { id: "service_needed", label: "Service needed", question: "What service do you need?", required: true },
        { id: "urgency", label: "Urgency", question: "How soon do you need help?", required: true },
        { id: "location", label: "Location", question: "What city is the service for?", required: false },
      ],
    },
  };
  await pool.query(
    `INSERT INTO ai_agents (workspace_id, name, status, tone, primary_goal, when_unsure, opening_message, escalation_message, behavior_settings)
     VALUES ($1, 'Mia', 'ACTIVE', 'Friendly & professional', 'Book appointments', 'Escalate to a human', 'How can I help you today?', 'I will connect you with the team.', $2::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, tone = EXCLUDED.tone, primary_goal = EXCLUDED.primary_goal, when_unsure = EXCLUDED.when_unsure, opening_message = EXCLUDED.opening_message, escalation_message = EXCLUDED.escalation_message, behavior_settings = EXCLUDED.behavior_settings, updated_at = now()`,
    [workspaceId, JSON.stringify(behaviorSettings)],
  );
  await pool.query(
    `INSERT INTO services (workspace_id, name, description, price_text, duration_minutes, active)
     VALUES ($1, 'QA Consultation', 'A 30 minute consultation used for the inbound voice acceptance flow.', '$120', 30, true)`,
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

  const voiceNumber = "+12025550400";
  const voiceCredentials = encryptCredentials({ apiKey: "ci-telnyx-api-key" });
  const voiceSettings = {
    phone: voiceNumber,
    connectionId: "ci-call-control-connection",
    webhookPublicKey,
  };
  const voiceIntegration = await pool.query(
    `INSERT INTO integrations (workspace_id, category, provider, mode, status, encrypted_credentials, settings)
     VALUES ($1, 'COMMUNICATION', 'telnyx', 'BYOP', 'CONNECTED', $2::jsonb, $3::jsonb)
     RETURNING id`,
    [workspaceId, JSON.stringify(voiceCredentials), JSON.stringify(voiceSettings)],
  );

  await pool.query(
    `INSERT INTO capability_bindings (workspace_id, capability, integration_id, mode)
     VALUES ($1, 'CALENDAR', $2, 'BYOP'), ($1, 'VOICE', $3, 'BYOP')
     ON CONFLICT (workspace_id, capability) DO UPDATE SET integration_id = EXCLUDED.integration_id, mode = EXCLUDED.mode, updated_at = now()`,
    [workspaceId, calendarIntegration.rows[0].id, voiceIntegration.rows[0].id],
  );

  const invalid = await sendWebhook(
    workspaceId,
    eventPayload("call.initiated", "m7-invalid", "call-invalid", "control-invalid", { from: "+15550009999", to: voiceNumber }),
    false,
  );
  assert(invalid.response.status === 401, `Expected invalid voice signature to return 401, received ${invalid.response.status}.`);

  const callSessionId = `call-m7-${Date.now()}`;
  const callControlId = `control-m7-${Date.now()}`;
  const caller = "+15550001111";
  const preexistingContact = await pool.query(
    `INSERT INTO contacts (workspace_id, name, phone) VALUES ($1, 'Existing SMS Customer', $2) RETURNING id`,
    [workspaceId, caller],
  );
  await pool.query(
    `INSERT INTO contact_identities (workspace_id, contact_id, channel, external_id, normalized_value)
     VALUES ($1, $2, 'SMS', $3, $3)`,
    [workspaceId, preexistingContact.rows[0].id, caller],
  );
  const initiated = await sendWebhook(
    workspaceId,
    eventPayload("call.initiated", "m7-call-1", callSessionId, callControlId, { from: caller, to: voiceNumber }),
  );
  assert(initiated.response.status === 200 && initiated.data?.processed === 1, `Inbound call initiation failed: ${initiated.text}`);

  const callRow = await waitFor(
    pool,
    `SELECT id, mode, status, recording_consent_status, metadata FROM voice_calls WHERE workspace_id = $1 AND external_call_id = $2 LIMIT 1`,
    [workspaceId, callSessionId],
    (rows) => rows.rowCount === 1,
    "voice call creation",
  );
  const callId = callRow.rows[0].id;
  assert(callRow.rows[0].mode === "AI_FIRST", `Expected AI_FIRST mode, got ${callRow.rows[0].mode}.`);
  assert(callRow.rows[0].recording_consent_status === "PENDING", "Recording consent was persisted before disclosure/consent.");

  const answered = await sendWebhook(workspaceId, eventPayload("call.answered", "m7-call-2", callSessionId, callControlId));
  assert(answered.data?.processed === 1, "Answered voice event was not processed.");

  let consentState = await pool.query(
    `SELECT recording_status, recording_consent_status, transcript_status, metadata FROM voice_calls WHERE id = $1`,
    [callId],
  );
  assert(consentState.rows[0].recording_status === "PENDING", "Recording started before explicit consent.");
  assert(consentState.rows[0].recording_consent_status === "PENDING", "Explicit consent was incorrectly inferred from the disclosure.");
  assert(consentState.rows[0].transcript_status === "PENDING", "Transcription started before explicit consent.");

  const consent = await sendWebhook(
    workspaceId,
    eventPayload("call.gather.ended", "m7-consent", callSessionId, callControlId, {
      digits: "1",
      status: "valid",
    }),
  );
  assert(consent.data?.processed === 1, "Explicit keypad recording consent event was not processed.");

  consentState = await pool.query(
    `SELECT recording_status, recording_consent_status, recording_disclosed_at, metadata FROM voice_calls WHERE id = $1`,
    [callId],
  );
  assert(consentState.rows[0].recording_status === "RECORDING", "Recording did not start after affirmative consent.");
  assert(consentState.rows[0].recording_consent_status === "GRANTED", "Affirmative keypad recording consent was not persisted.");
  assert(consentState.rows[0].recording_disclosed_at, "Recording consent evidence timestamp was not persisted.");

  const qualificationTurn = await sendWebhook(
    workspaceId,
    eventPayload("call.transcription", "m7-turn-1", callSessionId, callControlId, {
      transcription_data: { transcript: "I need a QA Consultation today. How much is it?", is_final: true, confidence: 0.97 },
    }),
  );
  assert(qualificationTurn.data?.processed === 1, `Qualification voice turn failed: ${qualificationTurn.text}`);

  const qualified = await waitFor(
    pool,
    `SELECT status, qualification_score, qualification_data, qualification_completed_at FROM leads WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
    (rows) => rows.rows[0]?.status === "QUALIFIED",
    "server-authoritative voice lead qualification",
  );
  assert(qualified.rows[0].qualification_score >= 67, "Voice lead qualification score was not computed.");
  assert(qualified.rows[0].qualification_data?.service_needed === "QA Consultation", "Voice qualification did not persist the configured service answer.");
  assert(qualified.rows[0].qualification_data?.urgency === "Today", "Voice qualification did not persist the configured urgency answer.");
  assert(qualified.rows[0].qualification_completed_at, "Voice qualification completion time was not persisted.");

  const groundedReply = await waitFor(
    pool,
    `SELECT body FROM messages WHERE workspace_id = $1 AND channel = 'PHONE' AND direction = 'OUTBOUND' AND sender_type = 'AI' AND body LIKE 'QA Consultation is $120%' LIMIT 1`,
    [workspaceId],
    (rows) => rows.rowCount === 1,
    "grounded voice knowledge response",
  );
  assert(groundedReply.rows[0].body.includes("$120"), "Voice knowledge response was not grounded in configured pricing.");

  const availability = await sendWebhook(
    workspaceId,
    eventPayload("call.transcription", "m7-turn-2", callSessionId, callControlId, {
      transcription_data: { transcript: "What times are available tomorrow?", is_final: true, confidence: 0.96 },
    }),
  );
  assert(availability.data?.processed === 1, "Voice availability turn failed.");
  await waitFor(
    pool,
    `SELECT body FROM messages WHERE workspace_id = $1 AND channel = 'PHONE' AND sender_type = 'AI' AND body = 'I have a 10:00 AM opening tomorrow.' LIMIT 1`,
    [workspaceId],
    (rows) => rows.rowCount === 1,
    "voice availability response",
  );

  const booking = await sendWebhook(
    workspaceId,
    eventPayload("call.transcription", "m7-turn-3", callSessionId, callControlId, {
      transcription_data: { transcript: "My name is Voice Visitor, voice.visitor@example.com. Book the 10:00 AM slot", is_final: true, confidence: 0.98 },
    }),
  );
  assert(booking.data?.processed === 1, "Voice booking turn failed.");

  const appointment = await waitFor(
    pool,
    `SELECT status, booking_source FROM appointments WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
    (rows) => rows.rows[0]?.status === "CONFIRMED",
    "voice appointment booking",
  );
  assert(appointment.rows[0].booking_source === "PHONE_AI", `Expected PHONE_AI booking source, got ${appointment.rows[0].booking_source}.`);

  const contact = await pool.query(
    `SELECT c.id, c.name, c.email, ci.normalized_value
       FROM contacts c JOIN contact_identities ci ON ci.contact_id = c.id
      WHERE c.workspace_id = $1 AND ci.channel = 'PHONE' AND ci.normalized_value = $2 LIMIT 1`,
    [workspaceId, caller],
  );
  assert(contact.rows[0]?.id === preexistingContact.rows[0].id, "Inbound voice did not reuse the existing SMS contact with the same phone.");
  assert(contact.rows[0]?.name === "Voice Visitor", "Voice orchestrator did not update the caller name.");
  assert(contact.rows[0]?.email === "voice.visitor@example.com", "Voice orchestrator did not capture the caller email.");
  const callerIdentities = await pool.query(
    `SELECT channel FROM contact_identities WHERE workspace_id = $1 AND contact_id = $2 ORDER BY channel`,
    [workspaceId, preexistingContact.rows[0].id],
  );
  assert(callerIdentities.rows.some((row) => row.channel === "SMS") && callerIdentities.rows.some((row) => row.channel === "PHONE"), "Unified caller contact is missing SMS/PHONE identities.");

  const hangup = await sendWebhook(workspaceId, eventPayload("call.hangup", "m7-hangup", callSessionId, callControlId, { hangup_cause: "normal_clearing" }));
  assert(hangup.data?.processed === 1, "Voice hangup event failed.");

  const recording = await sendWebhook(
    workspaceId,
    eventPayload("call.recording.saved", "m7-recording", callSessionId, null, {
      recording_id: "recording-m7-1",
      recording_urls: { wav: `${baseUrl}/api/dev/e2e/voice-recording` },
      recording_started_at: new Date(Date.now() - 8000).toISOString(),
      recording_ended_at: new Date().toISOString(),
    }),
  );
  assert(recording.data?.processed === 1, `Voice recording archive event failed: ${recording.text}`);

  const archived = await waitFor(
    pool,
    `SELECT status, recording_status, recording_object_key, recording_consent_status, transcript_status FROM voice_calls WHERE id = $1`,
    [callId],
    (rows) => rows.rows[0]?.recording_status === "AVAILABLE",
    "archived call recording",
  );
  assert(archived.rows[0].status === "COMPLETED", "Voice call did not complete after hangup.");
  assert(archived.rows[0].recording_object_key?.includes(`voice/${callId}/recording.wav`), "Call recording was not archived under the workspace/call object key.");
  assert(archived.rows[0].recording_consent_status === "GRANTED", "Archived call lost recording consent state.");
  assert(archived.rows[0].transcript_status === "COMPLETE", "Call transcript was not finalized.");

  const transcript = await pool.query(
    `SELECT speaker, text, sequence FROM voice_transcript_segments WHERE workspace_id = $1 AND voice_call_id = $2 ORDER BY sequence`,
    [workspaceId, callId],
  );
  assert(transcript.rows.some((row) => row.speaker === "CUSTOMER" && row.text.includes("QA Consultation today")), "Caller transcript segment was not persisted.");
  assert(transcript.rows.some((row) => row.speaker === "AI" && row.text.includes("$120")), "AI transcript segment was not persisted.");

  const usage = await pool.query(
    `SELECT count(*)::int AS count, coalesce(sum(credits_charged), 0)::int AS credits FROM usage_events WHERE workspace_id = $1 AND capability = 'VOICE' AND reference_id = $2`,
    [workspaceId, callId],
  );
  assert(usage.rows[0].count === 1, "Voice usage was not persisted exactly once for the call.");
  assert(usage.rows[0].credits === 0, "BYOP voice transport incorrectly charged hosted credits.");

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await page.getByLabel("Channel filter").selectOption("PHONE");
  await page.getByText("Voice Visitor", { exact: true }).first().click();
  await page.getByText("Incoming call", { exact: true }).waitFor({ timeout: 10_000 });
  const audio = page.locator(`audio[src="/api/voice/calls/${callId}/recording"]`);
  assert(await audio.count() === 1, "Inbox did not render the archived recording as the primary call artifact.");
  await page.getByRole("button", { name: "View transcript" }).click();
  await page.getByText("I need a QA Consultation today. How much is it?", { exact: true }).waitFor({ timeout: 10_000 });
  assert(await page.getByText("QA Consultation is $120. I can also check tomorrow's availability.", { exact: true }).count() === 1, "Expandable transcript did not render the AI response.");
  await assertNoHorizontalOverflow(page, "Voice Inbox desktop");
  await page.screenshot({ path: path.join(outputDir, "voice-inbox-desktop.png"), fullPage: true });

  await page.goto(`${baseUrl}/ai-agent`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Behavior" }).click();
  await page.getByText("Lead qualification", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByLabel("Phone voice").selectOption("marcus-us-1");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor({ timeout: 10_000 });
  const savedAgentSettings = await pool.query(
    `SELECT behavior_settings FROM ai_agents WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
  );
  assert(savedAgentSettings.rows[0]?.behavior_settings?.voice?.profileKey === "marcus-us-1", "AI Agent voice setting did not persist through /api/agent.");
  assert(savedAgentSettings.rows[0]?.behavior_settings?.qualification?.criteria?.length === 3, "AI Agent qualification settings were not preserved on save.");
  await page.screenshot({ path: path.join(outputDir, "voice-settings-desktop.png"), fullPage: true });

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "networkidle" });
  await page.getByLabel("Channel filter").selectOption("PHONE");
  await page.getByText("Voice Visitor", { exact: true }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page, "Voice Inbox mobile");
  await page.screenshot({ path: path.join(outputDir, "voice-inbox-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await pool.query(`UPDATE business_hours SET enabled = false, updated_at = now() WHERE workspace_id = $1`, [workspaceId]);
  const afterHoursSessionId = `call-m7-after-hours-${Date.now()}`;
  const afterHours = await sendWebhook(
    workspaceId,
    eventPayload("call.initiated", "m7-after-hours", afterHoursSessionId, `control-after-${Date.now()}`, { from: "+15550002222", to: voiceNumber }),
  );
  assert(afterHours.data?.processed === 1, "After-hours call initiation failed.");
  const afterHoursRow = await waitFor(
    pool,
    `SELECT mode FROM voice_calls WHERE workspace_id = $1 AND external_call_id = $2 LIMIT 1`,
    [workspaceId, afterHoursSessionId],
    (rows) => rows.rowCount === 1,
    "after-hours voice call mode",
  );
  assert(afterHoursRow.rows[0].mode === "AFTER_HOURS", `Expected AFTER_HOURS mode, got ${afterHoursRow.rows[0].mode}.`);

  const beforeDuplicate = await pool.query(`SELECT count(*)::int AS count FROM voice_calls WHERE workspace_id = $1`, [workspaceId]);
  const duplicate = await sendWebhook(
    workspaceId,
    eventPayload("call.initiated", "m7-after-hours", afterHoursSessionId, "ignored-control", { from: "+15550002222", to: voiceNumber }),
  );
  assert(duplicate.data?.duplicates === 1, "Duplicate voice webhook event was not recognized.");
  const afterDuplicate = await pool.query(`SELECT count(*)::int AS count FROM voice_calls WHERE workspace_id = $1`, [workspaceId]);
  assert(afterDuplicate.rows[0].count === beforeDuplicate.rows[0].count, "Duplicate voice webhook created a second call.");

  assert(runtimeErrors.length === 0, `Browser/runtime errors detected: ${runtimeErrors.join(" | ")}`);
  console.log("Milestone 7 browser verification passed for signed Telnyx inbound webhooks, explicit recording consent, shared qualification/knowledge/availability/booking, durable recording archival, synchronized transcript, BYOP usage, after-hours routing, and responsive unified Inbox.");
} finally {
  await pool.end();
  await browser.close();
}

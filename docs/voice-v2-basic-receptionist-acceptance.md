# V2 — Live basic AI receptionist: local acceptance contract

**Business objective:** A real caller dials a customer-authorized AI Caller-managed Telnyx US number, hears the configured assistant, speaks one business-knowledge question, and hears a grounded answer produced through the owner's global **direct OpenAI GPT-5.6 Luna** account. This is the *basic turn-based receptionist* gate, not yet V3 real-time interruption/latency acceptance.

**Gate status:** Awaiting a real local inbound call. CI's guarded Telnyx/OpenAI fixtures are useful regression checks but cannot certify voice quality or actual carrier routing. This stage does not require US 10DLC SMS registration and must not send any unapproved outbound SMS.

## Prerequisites and cost warning

- V1 local provider probe accepted, including both real API credentials and the Telnyx webhook-signing public key.
- A workspace with completed business profile, one configured AI Agent, at least one approved FAQ/service/price that can be asked about during the call, and sufficient credits to purchase and exercise a managed number.
- A **public HTTPS tunnel** (or staging URL) terminating at your local Next.js app on port 3000. Telnyx cannot call `http://localhost:3000` from its infrastructure.
- A separately reachable database, app, and worker. Telnyx number search and purchasing may incur carrier/credit charges; confirm the displayed price before pressing the button. Do not create a duplicate Call Control application manually: managed number provisioning creates one.
- `HOSTED_WEBHOOK_BASE_URL` must point to the **app** on port 3000, not to the voice media gateway on port 3002.
- The current `voice/gateway.ts` only authenticates/counts media; V2 uses Telnyx Call Control transcription webhooks and `speak`. Leave `VOICE_GATEWAY_URL` unset unless you intentionally have a publicly reachable gateway. The worker remains required for phone order reconciliation.

## 1. Configure and start

Use a non-production workspace and an external test phone. If your local auth currently works with `BETTER_AUTH_URL=http://localhost:3000`, **keep it**; the new webhook base is independent.

In `.env.local` (untracked):

```dotenv
BETTER_AUTH_URL=http://localhost:3000
HOSTED_WEBHOOK_BASE_URL=https://YOUR-ACTUAL-TUNNEL.example-TLD
HOSTED_AI_PROVIDER=openai
HOSTED_AI_MODEL=gpt-5.6-luna
HOSTED_AI_API_KEY=<your-direct-OpenAI-key>
HOSTED_TELNYX_API_KEY=<your-Telnyx-key>
HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY=<your-Telnyx-signing-public-key>
```

The URL shown is only a placeholder. Use your actual public HTTPS tunnel URL, with no path or query. Do not use an IP address, `localhost`, an `http://` URL, or a local-only hostname. If your deployment already has public HTTPS `BETTER_AUTH_URL`, you may omit `HOSTED_WEBHOOK_BASE_URL`.

```bash
npm install --no-audit --no-fund
npm run db:migrate
npm run dev
# Separate terminal:
npm run worker
# Separate terminal: start your own trusted HTTPS tunnel forwarding to localhost:3000
```

From a different network if possible, verify `https://YOUR-ACTUAL-TUNNEL/api/health` reaches the real local Next.js service. The existing `/api/health` endpoint checks the database. Do **not** send fabricated Telnyx events to the voice webhook; live events must be signed by Telnyx.

For production/staging, do not terminate TLS incorrectly or publicly expose the database, admin endpoints, or secrets. Do not log API keys or raw provider headers.

## 2. Provision and verify routing

1. Sign in as workspace owner, open **Settings → Phone & Messaging** or communication onboarding, and search US voice+SMS-capable inventory.
2. Inspect pricing/credits; confirm the purchase **once**. The app must reject an unreachable public webhook URL with `PUBLIC_WEBHOOK_URL_REQUIRED` **before** reserving credits or creating a Telnyx app/number order.
3. Confirm status becomes `ACTIVE` only once Telnyx order and owned inventory are fully usable. If `PROVISIONING`/`RECONCILING`, leave the worker running and let the product reconcile; do not repeat purchase with a new request ID.
4. Run `npm run verify:voice-providers:live` again. Its Telnyx line should no longer say `no Call Control application found yet` when this account has an app.
5. Confirm in Telnyx that the application's **v2 voice callback** is the public tunnel URL ending in `/api/webhooks/voice/telnyx/<workspace-id>`, and the purchased number is assigned to it. Do not paste the private account details or raw webhook signatures.
6. Phone UI should show `Calls: Active` while outbound SMS may independently show `Registration required` or `Registration pending`. This is expected while Issue #24 is unresolved.

**If you change your tunnel hostname after purchasing the number**, update `HOSTED_WEBHOOK_BASE_URL`, restart the local app, then use **Settings → Phone & Messaging → Repair voice routing**. This owner-only action PATCHes the exact persisted Telnyx Call Control application with the new voice callback. It does not repurchase, release, or replace the number and does not change SMS approval. Repeat the live probe and call test after repair. Keep a stable tunnel for the test where possible.

## 3. Make a live call

1. Call the number from a different phone; let the configured assistant answer.
2. Complete the recording disclosure or explicit DTMF `1` consent as configured. If consent is declined, the app must not transcribe/record the conversation.
3. Listen for the configured opening message, spoken in the chosen voice.
4. Ask a question whose approved answer is in the workspace knowledge (e.g. a configured service price). Avoid real patient/customer data during testing.
5. Wait for the AI answer. Confirm that it is relevant and grounded in that *actual* workspace's knowledge, not generic invented pricing or information from another workspace.
6. Ask a brief follow-up to verify the second turn can proceed; hang up normally.
7. In **Inbox → Phone**, confirm the correct contact and conversation, one call recording (if consented and Telnyx recording callback succeeded), caller transcript segments and spoken AI transcript. Confirm no duplicated or cross-workspace messages and the relevant AI/voice usage events.

The `Voice AI reply accepted by telephony provider` server log contains `callId`, `orchestrationMs` and `voiceTurnMs`; **voiceTurnMs is server transcription-to-speak-command processing time, not audible end-to-end latency**. Separately estimate the real caller-perceived gap between finishing a question and hearing the AI reply.

## Definition of working — all required for V2 acceptance

| Check | Required evidence |
|---|---|
| Public routing | Signed Telnyx callback accepted and correct workspace/number identified |
| Call answered | Real external caller hears an AI assistant; no unintended hang-up |
| Consent | Configured recording/consent policy respected |
| Greeting | Correct assistant name, opening message, voice profile |
| Recognition | Final caller transcription meaningfully matches spoken question |
| Reasoning | Direct hosted GPT-5.6 Luna generates a grounded, helpful answer |
| Speech | Caller hears the actual AI answer, not just a saved transcript |
| Two turns | A follow-up utterance also receives an appropriate answer |
| Persistence | Call/contact and transcript visible in correct Inbox; recording where consented and saved |
| Isolation | No other workspace, phone, conversation, or customer is mixed in |
| Billing | Voice and AI usage persisted without duplicates; no outbound SMS sent without approval |

**Fail:** silent AI after transcription, fabricated prices, mismatched workspace/destination, stale local callback, missing actual speech, consent bypass, duplicate charge, or unexpected SMS sends. Record failures even if the carrier/API returned HTTP 200.

**V2 does not claim:** natural barge-in, real-time streaming, subsecond latency, multi-action task completion, speech overlap handling, zero downtime, or passed US messaging approval. Those belong to V3–V5 and Issue #24.

## Troubleshooting evidence (redact)

Send this report without keys, raw signed headers, full phone numbers, or customer PII:

```text
Stage: V2 — Live basic AI receptionist
Commit SHA:
Local OS / Node version:
Tunnel hostname only (no secret URL/query):
Hosted AI provider/model: openai / gpt-5.6-luna
Managed phone status: ACTIVE / PROVISIONING / RECONCILING / other
Telnyx voice app exists and points to current tunnel: yes / no
Call received: yes / no
Greeting heard / consent result:
Question asked (test business facts only):
Transcription observed:
AI text response recorded:
AI response heard on the phone:
Caller-perceived delay (approximately seconds):
Voice AI reply accepted log: callId + orchestrationMs + voiceTurnMs
Inbox call/contact/transcript/recording:
Usage event / duplicate result:
Error codes or sanitized logs:
V2 result: PASS / FAIL / BLOCKED
```

## V2 failure isolation

- **No number / no Call Control app:** inspect managed-number status and worker; do not manually buy a duplicate number.
- **Telnyx app points to localhost or stale tunnel:** fix deployment/tunnel and click **Repair voice routing**. Do not retry purchasing the number. This action updates the existing voice app only; if you also need to fix a stale SMS webhook, handle that separately under the messaging compliance workstream.
- **No webhook arrives:** validate public HTTPS tunnel, number's exact Call Control assignment and callback URL.
- **Webhook returns 401:** inspect the public signing-key configuration and raw-body handling; do not disable verification.
- **Webhook returns 409:** investigate workspace/number/call lifecycle mismatch or out-of-order events, not the AI API key.
- **Opening message heard, but no response:** check `transcription_start`, final `call.transcription` delivery, orchestrator errors, model/credit usage, and `speak` acceptance.
- **AI transcript saved but no audible speech:** inspect Telnyx `speak` command result and call-leg state.
- **No recording:** verify consent, `call.recording.saved`, storage backend and guarded download behavior.
- **Number activation blocked by Telnyx:** record carrier HTTP status and order state; do not claim the live call passed. 10DLC messaging restrictions do not independently certify or invalidate voice capability.

**Acceptance is pending until the owner returns an actual live call report against the exact PR/deployment commit.**

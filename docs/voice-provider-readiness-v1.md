# V1 — Hosted voice provider readiness (local acceptance contract)

**Objective:** AI Caller can reach the owner's global OpenAI API using `gpt-5.6-luna` and authenticate to the owner's global Telnyx Call Control account **before** attempting to declare a live receptionist operational.

**Status at PR creation:** Implementation ready for independent review and live local acceptance. Never label the AI voice or production calling "verified" from a passing fixture test. This check does not call any real phone number.

## Configuration

Set the following in a local, untracked `.env.local` file or your deployment secrets. Do not paste values into GitHub, issues, logs, or chat.

```dotenv
HOSTED_AI_PROVIDER=openai
HOSTED_AI_API_KEY=<your-own-OpenAI-API-key>
HOSTED_AI_MODEL=gpt-5.6-luna
HOSTED_TELNYX_API_KEY=<your-own-Telnyx-API-key>
HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY=<your-own-Telnyx-Ed25519-public-key>
```

- `HOSTED_AI_API_KEY` is a **direct OpenAI API key**, not an OpenRouter key. The OpenAI request uses `https://api.openai.com/v1/responses`.
- The host provides these global keys; end users do not need to configure their own AI or carrier accounts.
- Keep existing app prerequisites: database, auth, encryption key, migrations and normal app/worker deployment. Those are not tested by this standalone provider probe.
- Telnyx SMS registration is independent and Issue #24 remains open. A denied 10DLC API does **not** imply the Call Control API is unavailable.
- The Integrations screen now uses server configuration presence for the hosted AI badge: **Server configured** is not a successful live test.

## Run these checks

```bash
npm ci
npm run test:voice-readiness
npm run verify:voice-providers
npm run verify:voice-providers:live
```

The last command explicitly performs **one small billable OpenAI text-generation request** and **one read-only Telnyx Call Control request**. It uses no fixture credentials, does not buy a phone number, submit a brand/campaign, place a call, or send SMS. It prints outcome codes, never provider response bodies or credentials. Both commands exit nonzero on failure. The OpenAI check expects the word `READY` from the actual selected model; the Telnyx check validates the Call Control listing response, and reports whether a Call Control application exists.

**Working means all of the following:**

1. Configuration preflight identifies OpenAI and `gpt-5.6-luna`, both API keys and the Telnyx webhook public key, and is not running the guarded fixture mode.
2. Live OpenAI Responses request successfully generates the expected output with the owner's configured key and model.
3. Live Telnyx Call Control listing returns a correctly shaped, authenticated success (whether it contains applications is reported separately).
4. The Integrations screen no longer shows Hosted AI as connected by default when `HOSTED_AI_API_KEY` is missing; it says **Server configured** when the server has a key, not "live verified".
5. No API key or full provider response appears in logs, screenshots, PR comments or acceptance records.

**Fail / blocked:** Any missing key, wrong provider/model, fixture mode, HTTP error, timeout, malformed provider response, incorrect model output, misleading configuration status, or secret exposure means V1 must not be marked accepted.

**What V1 does not prove:** Live inbound-call routing, carrier number ownership, public webhook reachability/signatures, speech synthesis/recognition, voice quality, latency, multi-turn conversation, booking, actual usage-metering during calls, or Telnyx US SMS approvals. Those are separate gates V2–V5 and Issue #24.

## Acceptance feedback to send

```text
Stage: V1 — Hosted voice provider readiness
Repo commit SHA:
Operating system / Node version:
Deployment mode: local / staging
Configured model (no keys):
npm run test:voice-readiness: PASS / FAIL
npm run verify:voice-providers: PASS / FAIL
npm run verify:voice-providers:live: PASS / FAIL
Live probe lines (redacted):
Integrations > Our Credits badge: Server configured / Not configured
Telnyx Call Control application found: yes / no
Any error or unexpected behavior:
```

Record the actual commit hash and live test date in the acceptance register. A CI run using simulated providers is **not** a substitute for the local live probe.

## Planned stages after V1

- **V2 — Basic receptionist:** a real Telnyx number answers; disclosure works; customer speaks; transcription is interpreted by the global OpenAI model; the chosen voice speaks an appropriate answer. Record a sanitized call ID, transcript, observed latency and voice quality.
- **V3 — Sustained conversation:** multi-turn context, measured response latency, interruptions/barge-in, silence and overlapping speech have explicit pass/fail criteria. Do not claim the present gateway already implements streaming audio.
- **V4 — Tools in one call:** real contact/lead updates, authoritative availability and confirmed calendar booking; retry and replay must not duplicate bookings or messages.
- **V5 — Failure and handoff:** recording consent, provider failure fallback, duplicate/out-of-order webhooks, abandoned calls, credit exhaustion, and AI/human takeover all exercised with persisted audit data.

## Acceptance register

| Stage | Commit | Automated checks | Owner local feedback | Status |
|---|---|---|---|---|
| V1 | PR head pending | Pending CI | Pending live local test | Acceptance pending |
| V2 | — | — | — | Not started |
| V3 | — | — | — | Not started |
| V4 | — | — | — | Not started |
| V5 | — | — | — | Not started |

Update the row only after receiving evidence for the exact tested code. Do not report a stage as closed based on this document alone.

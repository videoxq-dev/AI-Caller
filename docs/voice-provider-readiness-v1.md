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
npm install --no-audit --no-fund
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

## V1 local acceptance evidence — September 19, 2026

User-reported local execution on macOS (Darwin x86_64), Node v22.19.0, commit `b7a0140cca0c9e5e21dfafa7715de89bcb272c65`:

- `npm run test:voice-readiness` **PASS**: all seven standalone Node unit tests.
- `npm run verify:voice-providers` **PASS**: direct OpenAI and Telnyx global key preflight.
- `npm run verify:voice-providers:live` **PASS**: direct OpenAI Responses generated expected result with `gpt-5.6-luna` (3,479 ms); Telnyx Call Control listing authenticated (973 ms).
- **V2 prerequisite outstanding:** the Telnyx account returned no Call Control applications. This is expected before the product provisions its first managed number: `provisionManagedPhoneNumber` creates the Call Control application and messaging profile as part of a customer-authorized purchase. Do not create a duplicate manually merely to satisfy V1. V2 must verify the provisioning flow creates the app, assigns the exact owned number, and exposes a reachable public webhook.
- Integrations `Our Credits` displayed **Server configured**; response reported `liveVerified: false`, correctly avoiding a misleading health claim.
- User reported no observed errors or secret leakage. Do not confuse this with the V2 real-call acceptance evidence.

CI run #853 on the exact reported commit failed because Vitest also discovered a `node:test` suite that is intended to run separately; the 275 existing Vitest tests passed, but the step failed before typecheck/build/browser checks. The test-runner discovery fix is committed after the user's local acceptance SHA. The final PR #26 CI run #35454833538 passed on head `2b595afad3795ffb68845b6d01d5569f9d579b3b`; PR #26 was squash-merged to main as `2707d192e904f6cc5e251665ed7000382af64cf3`. V1 is now closed for **provider reachability** only; call acceptance remains V2.

Note: this repository does not currently track `package-lock.json`; use `npm install` rather than `npm ci` until dependency locking is addressed independently. This is a build reproducibility improvement to track and resolve; do not represent `npm ci` as supported by this branch.

## Acceptance register

| Stage | Commit | Automated checks | Owner local feedback | Status |
|---|---|---|---|---|
| V1 | Live probe `b7a0140`; merged main `2707d192` | 7/7 local probe tests; final PR #26 CI #35454833538 GREEN | OpenAI Luna and Telnyx Call Control reachability PASS; no app before number purchase | Accepted and closed for provider reachability only |
| V2 | PR #27 | Code/CI in progress | Pending real external call and accepted transcript/audio | Local live acceptance pending |
| V3 | — | — | — | Not started |
| V4 | — | — | — | Not started |
| V5 | — | — | — | Not started |

Update the row only after receiving evidence for the exact tested code. Do not report a stage as closed based on this document alone.

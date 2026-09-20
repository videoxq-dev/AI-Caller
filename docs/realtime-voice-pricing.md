# Voice technology and billing: implementation contract

Status: **implementation in PR #30, live carrier acceptance pending**. The selectable mode,
PCMU media bridge, business tools, structured booking state, response-usage storage,
credit holds and call settlement are coded; these are not a certification of actual
carrier routing, audio quality or invoice reconciliation. Keep VOICE_REALTIME_ENABLED=false
until deployment, security review and live acceptance. Standard voice remains available.

## Planned user choice

Settings → Phone & Messaging → AI Voice Technology:

- **Standard (existing):** Telnyx STT → hosted text AI → Telnyx Speak. Current rate
  card: estimated $0.040 per started minute at 50% gross margin = 80 credits/minute.
  The existing AI text token charge is separately metered and must be disclosed;
  80 credits is NOT a verified all-in legacy price. Keep the existing path.
- **Realtime (new):** Telnyx bidirectional WebSocket audio ↔ OpenAI Realtime,
  direct speech-to-speech. Bill actual uncached/cached audio/text input and output
  tokens plus US-local telephony/media and recording components. The full model is
  `gpt-realtime-2.1`; `gpt-realtime-2.1-mini` is also rate-card-supported, but
  must pass separate live quality acceptance before being offered.

Store user preference separately from voice routing and snapshot it per call. A
change must affect only subsequently answered calls. The phone number, SMS
registration state, call recordings and shared business tools remain unchanged.

## Published USD vendor cost rates (2026-09-20)

OpenAI per one million tokens:

| Model | Audio input | Cached audio input | Audio output | Text input | Cached text input | Text output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gpt-realtime-2.1 | 32 | 0.40 | 64 | 4 | 0.40 | 24 |
| gpt-realtime-2.1-mini | 10 | 0.30 | 20 | 0.60 | 0.06 | 2.40 |

- https://developers.openai.com/api/docs/models/gpt-realtime-2.1
- https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini

Telnyx US **local inbound** public starting/list rates per minute:

| Component | COGS |
| --- | ---: |
| Voice API | $0.0020 |
| Inbound SIP, from | $0.0032 |
| Media streaming WebSocket | $0.0035 |
| Recording, if enabled | $0.0020 |
| Telnyx STT (caller transcript) | $0.0150 |
| Total excluding TTS greeting/disclosure | **from $0.0257** |
| One-time Telnyx greeting/disclosure TTS | **Conservative rate-card proxy: $0.000048 per character** |

- https://telnyx.com/pricing/voice-api
- https://telnyx.com/pricing/elastic-sip

US toll-free, carrier destination changes, account-specific discounts, taxes,
transfers, number rental, extra transcription, hosting, storage beyond included
provider rates, and Stripe fees are not included in this US-local estimate.
**Do not bill toll-free at the US-local rate.**

## Pricing and settlement contract

Existing credit face value: **1 credit = $0.001** (1,000 micro-USD).
The existing hosted system's targetMarginBps=5000 means **50% gross margin**
and retail=2x provider cost. The customer's explicit **50% markup** for the
Realtime product means retail=1.5x provider cost, approximately 33.33% gross
margin before other company costs. Do not silently apply both.

For each answered realtime call, snapshot the effective published/admin provider
rate cards at call start and accumulate authoritative `response.done.usage`
token counters across all model turns, deduplicated by response ID. Cached input
tokens are subsets of total input tokens: bill the non-cached remainder at normal
price and the cached subset at cached price. Do not infer costs from audio bytes,
conversation timestamps or transcript lengths. Bill call/stream/recording
components only for actual enabled services and according to verified Telnyx
invoice rounding. The foundation currently uses a conservative **started
minute** per component and full-call recording duration when enabled; verify
the billing units in live provider acceptance before charging live calls.

Cost is summed from each rate-card component at micro-USD precision, then:
`retailMicros = ceil(providerCostMicros × 1.5)`;
`credits = ceil(retailMicros / 1000)`. Rounding can make individual one-minute
credits slightly higher than exactly 1.5x; disclose rounding and total charges.

Hypothetical single one-minute **recorded** US-local call with 300 noncached
audio input, 600 audio output, 2,000 noncached text input and 200 text output
tokens and **250 Telnyx-rendered greeting/disclosure characters** (example token/character counts, NOT a per-minute OpenAI consumption guarantee):

| Model | OpenAI COGS | Telnyx COGS | Total COGS | Retail 50% markup | Credits |
| --- | ---: | ---: | ---: | ---: | ---: |
| gpt-realtime-2.1 | $0.06080 | $0.03770 | $0.09850 | $0.14775 | 148 |
| gpt-realtime-2.1-mini | $0.01668 | $0.03770 | $0.05438 | $0.08157 | 82 |

Monthly at exactly 1,000 calls with that same usage and 1-minute rounding:
full model provider $98.50 / retail $148.00; mini provider $54.38 /
retail $82.00. The selected Azure voice may have a different account-specific rate: $0.000048/character
is a conservative Telnyx HD TTS proxy, not an assertion that Azure always costs this amount.
Source: https://telnyx.com/pricing/text-to-speech . Confirm the actual provider bill.
Actual costs will vary with tokenized conversation history,
turn count, silence, caching, speaking time and customer behavior.

## Required work before Realtime may be enabled

- Authenticated bidirectional Telnyx ↔ OpenAI bridge, audio format validation,
  proper interruption cancellation, safe backpressure/timeouts and recovery.
- Workspace-authorized mode selection under Phone & Messaging, unavailable until
  credentials and realtime gateway are operational.
- Structured booking memory and server-authoritative tools (booking only after
  explicit caller approval, truthful staff escalation).
- Recording consent, recording archiving, normalized transcripts, workspace
  isolation and per-call model/voice mode snapshots.
- Durable response-usage deduplication, rate snapshot persistence, idempotent
  credit settlement/refunds, per-call budget/cap and spend authorization before
  realtime sessions start. Never trust user-supplied token counters for billing.
- Separate acceptance for US toll-free and BYOP, if offered; number rental/SMS
  remain independent of voice technology.
- Live Telnyx and OpenAI invoice reconciliation and customer-visible usage
  breakdown before declaring paid Realtime generally available.

The transcription line was added when connecting the live gateway to the existing caller transcript store; the earlier price example omitted this additional Telnyx STT cost. Source: https://telnyx.com/pricing/speech-to-text . Transcription runs asynchronously and does not gate Realtime responses. Actual Telnyx invoice rates must be reconciled before general availability.


## Deployment and live gate

Set HOSTED_AI_API_KEY, HOSTED_TELNYX_API_KEY, Telnyx webhook public key,
BETTER_AUTH_SECRET, DATABASE_URL and the HTTPS webhook URL. Deploy the separate
gateway Compose service with a trusted TLS terminating reverse proxy mapping
a dedicated public WSS hostname to internal port 3002. Set VOICE_GATEWAY_URL
to the WSS endpoint, and enable VOICE_REALTIME_ENABLED=true on all relevant
web/gateway runtime services only after confirming the gateway is reachable.
The independent gateway is not a substitute for the web webhook receiver.

To activate, complete local and carrier testing: service question, multi-clause
booking with changing date/time, interruption, human follow-up (never live
transfer), transcript/recording, workspace isolation and billing reconciled to
OpenAI response.done.usage and Telnyx account invoice. The user must perform a
real inbound call with an authorized managed Telnyx number. No production call
has been placed in automated CI. Issue #28 PostgreSQL trust authentication is
a separate production security release blocker.

# Voice technology and billing: implementation contract

Status: **pricing foundation only**. Realtime media bridge, user-selectable voice mode, durable
OpenAI response usage aggregation, debit settlement and live carrier acceptance are NOT yet
implemented by this pricing change. Do not show Realtime as active or charge customers before
those components are verified. Existing legacy voice is unchanged.

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
| Total, recorded example | **from $0.0257** |

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
tokens (example token counts, NOT a per-minute OpenAI consumption guarantee):

| Model | OpenAI COGS | Telnyx COGS | Total COGS | Retail 50% markup | Credits |
| --- | ---: | ---: | ---: | ---: | ---: |
| gpt-realtime-2.1 | $0.06080 | $0.02570 | $0.08650 | $0.12975 | 130 |
| gpt-realtime-2.1-mini | $0.01668 | $0.02570 | $0.04238 | $0.06357 | 64 |

Monthly at exactly 1,000 calls with that same usage and 1-minute rounding:
full model provider $86.50 / retail $130.00; mini provider $42.38 /
retail $64.00. Actual costs will vary with tokenized conversation history,
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

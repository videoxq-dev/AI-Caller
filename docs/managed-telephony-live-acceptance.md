# Managed Telnyx live-carrier acceptance

This checklist is the production/staging verification boundary for AI Caller-managed US phone numbers.

Automated CI intentionally uses guarded provider fixtures so it can deterministically verify application state transitions, webhook authentication, orchestration, billing, and recovery without purchasing real carrier resources. A green CI run **does not by itself prove live carrier deliverability**.

## Prerequisites

Use a non-production workspace and a Telnyx account/configuration that is safe for live staging.

Required deployment configuration:

- `HOSTED_TELNYX_API_KEY`
- `HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY`
- a public HTTPS `BETTER_AUTH_URL` **or** `HOSTED_WEBHOOK_BASE_URL` for local/staging tunnelling; the latter can differ from the local Better Auth sign-in URL
- the normal application and reconciliation worker processes running; the current media gateway is optional for turn-based voice acceptance, and its `VOICE_GATEWAY_URL` must not point Telnyx at an unreachable localhost stream
- enough AI Caller credits to purchase and exercise the number
- any applicable US messaging registration/verification already approved before testing outbound SMS

Do not place carrier credentials in test output, screenshots, issue comments, or source control.

## Evidence record

For every live run, record:

- commit SHA
- deployment/environment name
- UTC timestamp
- workspace ID or a non-sensitive staging label
- managed-number database ID (not carrier credentials)
- number type: local or toll-free
- provisioning result and final carrier status
- inbound-call result
- inbound-SMS result
- outbound-SMS result **only when messaging readiness is READY**
- relevant usage-event IDs / credit debits
- sanitized screenshots/log excerpts where useful

Never record API keys, webhook signing keys, full provider responses containing sensitive account data, or customer PII.

## 1. Provision through the product

1. Sign in as the workspace owner.
2. Open Communication setup or Settings → Phone & Messaging.
3. Search a US state/city/area code.
4. Choose a voice + SMS-capable number.
5. Confirm the purchase.
6. Verify the product initially shows a carrier activation state if Telnyx has not finalized the order.
7. Verify the number becomes `ACTIVE` only after the carrier order, ordered-number resource, and owned-number inventory are final/usable.
8. Verify the credit ledger contains exactly one phone-number purchase debit and the usage table contains exactly one purchase COGS event.
9. Verify `messaging_readiness` remains `NOT_REGISTERED`, `PENDING`, or `REJECTED` until an authoritative registration workflow sets it to `READY`.

### Failure/recovery check

During a dedicated staging run, simulate or induce an interrupted order response if safely possible. Verify the local record enters `RECONCILING`, no duplicate order is submitted, no refund is issued while carrier ownership is indeterminate, and the worker either adopts the exact owned number or keeps reconciliation pending.

## 2. Inbound call

1. Call the newly provisioned number from an external phone.
2. Verify Telnyx reaches the managed voice webhook and the webhook signature is accepted.
3. Verify the call is answered by the configured AI assistant.
4. Complete the configured recording disclosure/consent flow.
5. Ask a question grounded in configured business knowledge.
6. Exercise at least one server-authoritative tool such as qualification, availability, or booking.
7. Hang up.
8. Verify the unified conversation contains the call artifact/transcript and the usage ledger contains exactly one hosted voice charge for the call.

## 3. Inbound SMS

1. Send a text from an external phone to the managed number.
2. Verify the signed Telnyx inbound webhook is accepted and routed to the correct workspace/number.
3. Verify the inbound message appears in the unified conversation.
4. If outbound messaging is not `READY`, verify the AI does **not** attempt an outbound reply and the UI continues to show registration required/pending/rejected.
5. Verify inbound usage is metered once.

## 4. Outbound SMS — only after carrier approval

Do not run this step unless the managed number's persisted `messaging_readiness` is `READY` based on an authoritative carrier registration/verification result.

1. Send a staff reply or allow an AI reply from the conversation.
2. Verify Telnyx accepts the message.
3. Verify a delivery callback reconciles onto the same outbound message.
4. Verify the outbound SMS credit debit and provider-cost usage event are each recorded once.
5. Confirm no send is possible after manually moving readiness back to a non-ready state in staging.

## Acceptance

Live carrier deliverability may be described as verified only when the above evidence exists for the exact commit/deployment being evaluated.

Until that evidence exists, use wording such as:

> Application provisioning and carrier API contracts are verified by CI; live carrier deliverability has not yet been executed for this commit.

US messaging registration automation itself is tracked separately in issue #24.

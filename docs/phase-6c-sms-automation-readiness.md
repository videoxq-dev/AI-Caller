# Phase 6C — SMS Automation Readiness Inventory

Baseline: `main` at `e18972a55bd01897411541b8789cc7a863d603f1`. Phase 5 remains deferred.

## Existing behavior (not rebuilt)

- Phase 4 Builder supports `SEND_CUSTOMER_SMS` across inquiry, qualification, appointment, and escalation triggers. Message templates can use only registered event-specific variables.
- At publication the SMS purpose is classified and stored in an immutable workflow version. A classified `UNCERTAIN` message cannot publish.
- The durable action executor claims one delivery per workflow action and event; worker interruption/uncertain carrier acceptance does not automatically resend. Action and delivery outcomes are visible in Activity.
- The existing outbound SMS path checks managed number readiness, registration state and approved campaign purpose, link rules, recipient SMS consent/opt-out, credit reservation, and rechecks policy/consent just before carrier send.
- Appointment automation SMS revalidates appointment revision/state to avoid sending stale confirmations.
- Provider delivery webhooks and receipt persistence are already handled in the SMS framework. This PR does not introduce a second sender, outbox or SMS engine.

## Phase 6C incremental work

- Add a read-only, authenticated status endpoint for the *active workspace's* configured SMS route and carrier registration.
- Show a concise indicator only when the Builder includes an SMS action. The status differentiates an unconfigured sender, connected external (BYOP) provider with unverified carrier approval, pending/rejected managed registration, and a READY managed campaign with its actual approved purpose categories.
- A provider API key or server-level Telnyx authorization never counts as approval of an individual business's managed SMS campaign. A BYOP "connected" flag does not establish external carrier registration.
- Workflow drafts/publication remain available while carrier approval is pending. The send path is unchanged and still suppresses a message unless current send-time checks pass.
- SMS message inputs and publication validation now reject content longer than the outbound sender's existing 1,600-character limit; existing immutable published snapshots retain their schema.
- BYOP **automation SMS** now checks recipient consent and opt-outs both before creating a send and just before calling the provider; explicit promotional language cannot masquerade as transactional. Non-automated BYOP message policies remain a separate Phase 6D concern.
- No migration, new dependency, second managed number, or provider network call is needed to display readiness.

## Acceptance boundaries

CI exercises status transitions and tenant isolation, route authentication, existing SMS send-policy and durable-workflow tests, and typecheck/build/regression checks. **No approved business entity or live outbound carrier delivery is claimed.** Once a suitable registration is approved, acceptance needs a real transactional and (only if registered for it) marketing message, opt-out suppression, provider receipt, and send activity reconciliation.

The BYOP sender cannot independently verify external carrier campaign scope using AI Caller's managed-registration tables; the readiness UI must not depict a connected account as carrier-approved. Phase 6D must review remaining **non-automation BYOP message** policy and cross-channel controls.

# Booking remediation implementation ledger

Started: 2026-09-21. Implementation branch: `fix/booking-remediation-phase1-durable-drafts`.
Baseline: `c9413efc7b23a08052de3b02d119326e83f1f046`, the documentation-only commit after `fd47142`.

## Phase 0 — repository baseline

- Reviewed `docs/appointment-booking-e2e-remediation-plan.md`, `docs/appointment-booking-regression-2026-09-21.md`, CI, database migrations, pending action gate and native/external booking service.
- Migrations end at `0024_native_calendar_stale_binding_cleanup.sql` on the observed baseline.
- The old pending-action booking engine remains active until a complete new engine can safely take over. No implicit import or execution of old proposals.
- The existing calendar service routes native and external bookings differently; merely adding a draft table does **not** fix availability or booking.
- Production build SHA, provider settings, live calendar behavior and running DeployOS revision have not been verified.

## Phase 1 — first independently reviewable slice

- Added `0025_booking_drafts.sql` and matching Drizzle declarations.
- One active draft per workspace + **authenticated booking session key**. Calls use a call-scoped key, and widget sessions use their own key, even when their contact/conversation matches.
- New internal draft service checks workspace/contact/conversation/session/channel ownership, supports omitted-versus-null patches, optimistic versions, source-event replay suppression, cancellation and expiry.
- A material patch returns to `COLLECTING`, invalidating any future offers and previews tied to prior versions.
- In-flight commit/reconciliation states never expire as though an uncertain provider call had failed.
- No provider write, appointment write, or external HTTP route was added in this slice; the schema does not activate the incomplete new engine.

## Follow-on dependency order

1. Stored availability offers and immutable preview/delivery evidence with version checks.
2. Shared date/timezone resolver, service duration, native/external scheduling policy, provider error contracts.
3. Durable command/reservation/receipt/worker reconciliation and provider-specific deduplication.
4. Chat/voice/SMS/WhatsApp adapters, widget cards/history, staff timeline, legacy engine cutover.
5. PostgreSQL concurrency/fault-injection, browser, live-model, provider, real-audio, deployment and rollback verification.

The first PR must not be described as having fixed booking. Recheck current `main` and independently verify CI before merging. Database tests delete workspaces; run them only with a confirmed disposable test database. Never run test suites or schema experiments against the existing DeployOS volume.

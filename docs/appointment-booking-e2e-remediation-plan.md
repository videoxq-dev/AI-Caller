# AI Caller appointment booking: end-to-end remediation plan

Prepared: September 21, 2026. Reviewed baseline: commit `fd47142`.

## 1. Instructions for the implementing LLM

Implement this plan in the existing AI Caller repository. Deliver working code, additive database migrations, automated tests, a deployment runbook, and a verification report. This is an implementation assignment, not a request for another proposal or a prompt-only patch.

Read repository instructions and inspect the current branch before editing. The code may have advanced since this review. Preserve working fixes and user changes. Use existing project conventions and dependencies where suitable. Suggested module names and schemas below are design guidance; the behavioral requirements and acceptance criteria are mandatory.

Work through the phases in dependency order. Maintain a short progress checklist and record consequential implementation decisions. Continue through all locally achievable work. When credentials, production access, or actual business settings are unavailable, finish independent work and report the exact remaining validation or decision. Do not claim live verification from mocks, disable tests to make CI pass, or silently replace a failed external calendar with native scheduling.

Respect the authorization available in the execution session for deployment and live operations. Use isolated test workspaces, calendars, and contacts for live verification. Never send test messages to real customers or place unsolicited calls. Do not print secrets. Existing database suites delete shared data: run them only against a verified disposable test database.

### Objective

A customer can discuss, request, modify, select, and confirm an appointment across multiple turns. AI Caller preserves the request, checks authoritative availability, commits the exact confirmed booking once, and reports its actual persisted status. This must work in web chat and voice, with the shared SMS/WhatsApp orchestration paths kept compatible.

### Scope boundaries

- Implement booking collection, availability search, slot selection, confirmation, persistence, truthful responses, recovery, and deployment visibility.
- Preserve appointment list/detail, manual booking, cancellation, rescheduling, contact capture, agent capabilities, human takeover, existing billing, and automation behavior. Route shared scheduling operations through common validation so other entry points cannot defeat booking guarantees.
- Support the existing native, Google Calendar, Outlook, Cal.com, and Calendly paths according to their actual capabilities. Verify provider contracts before implementing new API behavior.
- Do not introduce a new scheduling vendor, rebuild the whole app, or create a staff dispatch/route-optimization system. Preserve current capacity semantics unless an existing resource model provides better information.
- Cancelling an uncommitted draft is required. New conversational workflows for cancelling/rescheduling confirmed appointments are not required; existing such functionality must continue to work.

## 2. Evidence and current implementation

The supplied screenshot shows lost date context, an incorrect claim that September 23 is past on September 21, unnecessary UTC demands, repeated contact acknowledgements, repeated confirmation, and leaked orchestration JSON.

The actual attachment contains AI Caller web, worker, gateway, migration, and PostgreSQL logs. Relevant events include three authoritative-availability fallback warnings and an invalid-orchestration warning at `2026-09-21T21:15:36Z`. These establish orchestration problems, not a particular provider booking failure.

At the reviewed baseline:

- `server/orchestrator/index.ts` already bypasses the planner to execute an awaiting stored action on explicit chat approval.
- `server/orchestrator/tools.ts` rejects incomplete/nested orchestration JSON and normalizes booking timestamps to UTC before hashing. Equivalent timestamp offsets alone need not change the hash; timezone/title/other payload fields still can.
- `server/orchestrator/pending-actions.ts` stores generic action proposals, uses payload hashes, and recognizes several approval phrases. Keep this subsystem for unrelated actions such as SMS.
- `server/voice/realtime-booking.ts` has partial call-scoped details and availability state. It is not a shared, versioned booking transaction.
- `server/domain/core/native-calendar.ts` and native appointment persistence already implement useful hours, buffer, conflict, daily-limit, and locking behavior.
- `server/domain/core/calendar-booking.ts` sends external availability and bookings to provider adapters without the same native policy pipeline.
- The Google adapter treats missing busy data as an empty list. External create operations lack a stable booking key in the common provider interface.
- Widget turn caching and history are primarily text-based; adding a button only to the current response will not make previews survive refresh or replay safely.
- Contact receipts currently identify submitted fields, rather than necessarily changed values.
- Both local `main` and cached `origin/main` referenced `fd47142` during review. This does not prove the production revision. Verify deployment independently; do not repeat an unverified push-failure diagnosis.

The earlier review ran 70 existing orchestrator/calendar-service unit tests successfully with mocked dependencies. It did not verify live providers, database integration, production deployment, or live model conversation quality.

## 3. Non-negotiable invariants

1. The model does not own booking state, calculate trusted UTC timestamps/end times, authorize commits, or decide whether a provider operation succeeded.
2. Every mutable draft, slot, preview, command, and appointment is bound to an authorized workspace and customer/session. An opaque ID is not authorization.
3. An omitted patch field preserves its value. Explicit clearing is distinct from omission. Unrelated questions do not erase or mutate booking details.
4. A material booking change invalidates previous availability/selection/confirmation. Cosmetic display-timezone changes that preserve the instant are handled separately from changing the intended local time.
5. Availability is established only by a successful authoritative check for the requested service, duration, resource, and date range. Errors and incomplete results are not empty calendars.
6. A slot ID identifies a stored offer, not a guaranteed reservation. It expires, is scoped to its draft/search context, and is revalidated before commit.
7. Only explicit approval of the applicable preview version authorizes booking. Saying yes to a question about checking availability or supplying details does not authorize booking.
8. Exactly one application command owns creation for a logical booking. Replays return its existing result or pending status. Concurrent requests cannot start independent creates for the same command.
9. An uncertain provider outcome blocks fresh creates until reconciled. A provider timeout is not proof of failure.
10. A confirmed response requires a durable appointment receipt and, for external bookings, verified provider success. No model-only success, failure, past-date, or availability assertions.
11. All channels use the same domain transitions and scheduling policy. Channel-specific code transports input, records delivery/consent evidence, and renders results.
12. Existing capability controls, customer identity checks, and human ownership are checked at execution time. A staged preview is not permission to bypass them later.
13. No customer sees internal protocol JSON, stack traces, provider credentials, or arbitrary planner output after a parsing failure.
14. An external calendar connection is not required for native scheduling. A configured external provider failure must not silently create a native appointment instead.

## 4. Target architecture

```text
Inbound message / button / finalized voice utterance
  -> authenticated, deduplicated event with channel/session identity
  -> classify intent and extract proposed field changes
  -> shared booking application service
       -> merge/version draft and resolve dates/service
       -> apply scheduling policy and query provider
       -> store offered slots and selection
       -> produce preview and record delivery context
       -> validate confirmation for that version
       -> persist command and reserve application capacity
       -> create/reconcile provider event if applicable
       -> persist appointment, receipt, and domain event
  -> render customer response from trusted result
```

Use PostgreSQL as the authority. Reuse the existing worker/job infrastructure for durable dispatch and reconciliation; no new infrastructure is necessary solely for this feature. Keep provider network calls outside long-running database transactions.

### Proposed service boundary

Introduce a cohesive `server/booking/` module, or the equivalent under `server/domain/core/`, with independently testable date resolution, state transitions, policy, persistence, confirmation, and command execution.

Example application operations:

```ts
patchDraft(context, { draftId, expectedVersion, patch, sourceEventId })
searchAvailability(context, { draftId, expectedVersion, query })
selectSlot(context, { draftId, expectedVersion, slotId })
preparePreview(context, { draftId, expectedVersion })
recordPreviewDelivery(context, deliveryEvidence)
confirmDraft(context, { draftId, expectedVersion, previewId, sourceEventId })
getBookingOutcome(context, { draftId })
cancelDraft(context, { draftId, expectedVersion, sourceEventId })
```

These are internal contracts, not a requirement to expose each method as a public endpoint. Derive identity, provider bindings, duration, and confirmation evidence server-side. Do not trust a caller-supplied workspace, customer, status, or provider receipt.

Return typed outcomes such as `NEEDS_DETAILS`, `NEEDS_CLARIFICATION`, `SLOTS_AVAILABLE`, `NO_SLOTS`, `PREVIEW_READY`, `COMMITTING`, `CONFIRMED`, `STALE_PREVIEW`, `SLOT_UNAVAILABLE`, `RECONCILING`, and `SERVICE_UNAVAILABLE`. Ordinary collection/clarification is not an operational failure or automatic escalation.

## 5. Persistence and lifecycle

Use additive migrations and database constraints, not application checks alone. Choose the next migration number after inspecting the repository.

### Booking drafts

Store at least:

| Area | Required information |
| --- | --- |
| Identity | Draft ID, workspace, contact, conversation, explicit booking-session identity; originating channel and call/widget session where applicable |
| Lifecycle | State, monotonically increasing booking version, created/updated/expiry timestamps, cancellation/supersession reason |
| Requested details | Service ID, service display snapshot, required location, requested local date/time or search range, customer timezone, source/explicitness of timezone |
| Derived schedule | Canonical UTC start/end after selection, server-derived duration, selected resource, business timezone, relevant policy/service configuration version or fingerprint |
| Provider binding | Integration/provider, calendar or event-type identity; bind the offer and command to the same configuration |
| Selection/confirmation | Selected slot ID, current preview ID/version, confirmation evidence/reference |
| Result | Stable booking command key, appointment ID, last typed error and recovery state |

Avoid conflicting sources of truth: requested local fields describe intent; selected UTC fields describe the resolved instant. Compute and validate their relationship in one place. Search ranges and unresolved expressions must not masquerade as a selected exact time. Keep customer display timezone separate from scheduling timezone.

Define one active draft per booking session initially. Starting a new appointment explicitly supersedes an uncommitted draft. A new phone call must not inherit a previous chat's unfinished booking merely because the contact/conversation matches. Resumption across sessions must be explicit and revalidated. Preserve access to the previous confirmed result for repeated approvals/status questions without creating another draft automatically.

### Offered slots and previews

Persist slot ID, draft/search revision, workspace/resource/provider binding, canonical start/end, service/duration/configuration identity, checked-at, and expiry. Store multiple offers for range searches. A selection or policy change must not leave a previously issued slot valid by accident.

Persist immutable preview content or structured fields, preview ID, draft version, confirmation question type, outbound message/voice response identity, and delivery state. An internal preview row is not evidence that the customer saw or heard it. Use the best channel-specific delivery evidence available; document what it guarantees.

### Commands, reservations, receipts, and events

Persist a unique logical booking command key, draft/version, immutable commit snapshot, selected integration, state, lease/attempt metadata, provider identifier/reference, appointment result, and recovery details. A dedicated table or carefully designed equivalent is acceptable.

Add a unique booking key/reference to appointments. Preserve existing uniqueness of integration/external event IDs. Use an application reservation/occupancy record or equivalent to prevent competing app requests from taking the same capacity while an external command is in progress. Do not advertise uncertain reservations as free merely because a lease expired.

Record business state transitions and their source event IDs. Use a durable outbox or equivalent atomic queue-dispatch pattern so a crash between saving a command and enqueueing work cannot strand it. Persist the appointment and its confirmed automation event atomically; ensure consumers remain idempotent.

### State transitions

```text
COLLECTING -> AVAILABILITY_CHECKED -> AWAITING_CONFIRMATION
AWAITING_CONFIRMATION -> COMMITTING -> CONFIRMED
COMMITTING -> RECONCILING -> CONFIRMED | FAILED

Editable states -> COLLECTING on a material change
Editable states -> CANCELLED | EXPIRED | SUPERSEDED
Commit rejection with proven no side effect -> recoverable failure/new offer
```

`AVAILABILITY_CHECKED` can mean offers exist; it does not imply one has been selected. Store selection explicitly. Preparing one exact, available proposal can select it and present a single confirmation question without an unnecessary extra yes/no turn.

Use optimistic version checks and atomic state updates. A stale availability response or model extraction must not overwrite a newer correction. Define valid transitions explicitly and enforce them in the domain service.

Once committing begins, the command snapshot is immutable. A later cancellation/change must first establish whether creation occurred; do not mutate or replace an in-flight command and create again. Recovery after process restart must use persisted state, not chat history.

## 6. Date, service, and availability correctness

### Language and date resolution

- Let the model propose structured fields and preserve the original date expression for clarification/audit as appropriate. Validate everything server-side.
- Resolve relative dates using an injectable clock and the intended customer/business timezone. State an inferred business timezone in the preview when the customer did not specify one.
- Support the screenshot forms: `Sep 23, 2026, 11:00 AM (Africa/Lagos)`, `September 30, 2026`, `10 am`, and `10 am UTC` supplied across turns.
- Define handling for omitted years, ambiguous numeric dates, weekday/date contradictions, invalid civil dates, and ambiguous abbreviations. Ask a targeted question instead of silently guessing where meaning changes the appointment.
- Handle nonexistent and repeated local times in daylight-saving zones. Use a tested timezone-aware library/runtime available in the actual deployment; do not rely on `new Date` parsing locale strings or the host timezone. Verify dependency compatibility before choosing a new library.
- Distinguish changing only the display zone from reinterpreting a wall-clock request in another zone. Preserve a selected instant when converting its display.
- Calculate end time from the authoritative service duration. If service/event-type duration is missing or inconsistent, clarify or report a configuration issue; do not silently use a generic 30-minute meeting for a four-hour service.
- Collect location/contact fields only when needed by the service/provider. Do not impose a street address on every appointment type. Persist required location into the final appointment/provider representation, not only transient voice state.

### Shared scheduling policy

Extract/reuse the native policy implementation so both availability and commit apply the same rules across supported providers:

- Business and calendar hours in their respective configured zones, enabled days, full service duration, buffers, daily limits, local appointments/reservations, and provider availability.
- Existing lead-time, booking-horizon, resource, holiday/exception, or capacity settings if present. Do not invent unsupported business requirements; record missing capabilities separately.
- Search-window boundaries and pagination: an exact start with a four-hour service requires checking the complete four-hour interval. A limit on returned slots is not proof that later times are unavailable.
- Document buffer semantics and test them so combining candidate and existing buffers does not unintentionally double the configured separation.
- Preserve existing single-resource/workspace behavior by default. If resources are modeled, lock/check the actual resource or capacity pool; do not expand to multi-crew dispatch in this remediation.

Recheck schedule/configuration and current availability during commit. If the slot changed, return alternatives without booking another time. Provider/calendar binding or service-policy changes require revalidation and, when material, a new preview.

### Provider contracts

Distinguish availability results that are successful and empty from failures, partial responses, malformed times, and unsupported operations. Validate provider IDs, time ranges, and actual confirmed times. Do not manufacture successful times from fallback parsing when validating a commit.

For Google, reject per-calendar free/busy errors or missing requested calendar results. For Outlook, handle pagination and provider timezone/recurrence semantics. Audit Cal.com and Calendly event-type selection, provider-enforced duration, required attendee fields, and booking status. Do not invent end times that contradict an event type or silently select the first unrelated event type.

Preserve tested native routing for workspaces with no usable external binding according to the application's explicit configuration rules. An outage/authentication error on an active configured provider is a typed provider error, not permission to switch scheduling systems.

Rechecking external availability is not an atomic reservation against a person editing their calendar independently. Prefer provider-enforced booking conflict checks where available. Document remaining race limitations for raw event calendars and define detection/reconciliation behavior; do not promise global exactly-once or perfect cross-system isolation.

## 7. Confirmation and idempotent commit algorithm

1. Authenticate the event and deduplicate using its persisted source ID. Resolve the exact booking session.
2. In a short transaction, load the draft/preview, validate ownership, expected version, expiry, delivery/confirmation context, permissions, and current conversation handling mode.
3. If the logical command is already complete, return the same appointment receipt. If it is committing or reconciling, return that status. Do not create a second command because the previous reply was lost.
4. Atomically claim the transition and persist the immutable command snapshot plus durable dispatch. Ensure only one execution owner can advance it.
5. Validate current policy/provider availability. Atomically claim local capacity with the same lock/constraint used by all app booking entry points, rechecking local conflicts at that boundary.
6. For native booking, persist appointment, command receipt, draft result, and confirmed domain event atomically where possible.
7. For external booking, use a persisted provider idempotency/reference mechanism appropriate to that provider. Persist any client-generated identifier before the network call. Use the snapshot's provider binding, not a newly resolved unrelated calendar.
8. On verified provider success, persist external linkage and the confirmed local receipt/event. Validate returned times against the confirmed preview; handle differences explicitly instead of silently accepting a changed appointment.
9. On a proven rejection with no side effect, release capacity and return a typed outcome. On timeout, lost response, worker crash after dispatch, or persistence failure after possible provider success, enter recovery and look up the operation before attempting another create.
10. A reconciliation worker retries safe reads with bounded backoff, recovers local persistence from known provider results, and records unresolved cases for staff. Where a provider cannot prove whether creation happened, keep the outcome uncertain and prevent blind retries.

Use Google client-generated event IDs and Outlook transaction IDs only according to current provider rules. Do not assume Cal.com or Calendly support identical mechanisms. Record a capability matrix with actual deduplication, lookup, conflict, and cancellation behavior for each adapter.

A generic "cancel provider event if local insert failed" is insufficient as the only recovery strategy: cancellation can fail too. Prefer recovery of the intended booking when success is known. Any compensating cancellation must itself have persisted outcome tracking.

Leases may recover abandoned execution ownership, but expiration alone cannot establish that an old provider call had no effect. Prevent overlapping workers from issuing unsafe duplicate creates after a lease timeout.

## 8. Conversation and channel integration

### Model boundary

Use a narrow, validated intent/patch schema for booking, such as request availability, patch details, select an offered slot, ask a question, decline/cancel a draft, or propose confirmation. The server validates confirmation from actual user events; the model cannot grant consent.

Allow questions alongside patches and preserve their order/meaning: "Yes, but make it noon" is a change, not confirmation of the old time. "How long is it?" should answer from the service record without resetting the draft. "Is it booked?" must query the persisted outcome, including across restarts.

Use schema-constrained model output where supported by the configured AI provider. Keep strict server validation, bounded repair, and a safe clarification fallback for every provider. A parser/repair failure must have no booking/contact/escalation side effects. Do not stream raw model tokens into customer text before validation.

Generate dates, availability lists, previews, pending-state messages, and receipts from server data/templates. Model-written conversational connective text must not override these facts. Provide typed reasons for unavailable times and distinguish "no slots" from "could not check".

Apply contact patches only for supplied/changed information, compute actual diffs, and omit repetitive receipts for unchanged values. Preserve existing consent and qualification behavior without making them implicit consequences of every booking turn.

### Web chat

- Extend widget response, message metadata, history, and cached turn result contracts to include a versioned booking card/receipt, not only `responseText`.
- Render an accessible preview with service, required location, full date/year, start/end, customer timezone, and Confirm/Change controls. Disable obsolete, expired, already-confirmed, or currently-submitting controls and show authoritative returned status.
- Submit confirmation using the authenticated widget session, draft/version/preview references, and a client event ID. Resolve workspace/customer identity from the session. No arbitrary appointment payload from the browser.
- Preserve cards through refresh, history polling, SSE completion, cached response replay, reconnect, and multiple browser tabs. A stale card cannot confirm a newer preview.
- Typed confirmation uses the same service and preview binding. It must not rely on parsing previously rendered English text.
- A disconnected stream or lost HTTP response after booking must recover the existing receipt. Do not instruct the customer to create another booking merely because reply delivery failed.
- Inspect both the public widget and staff conversation timeline used to view chats. Render structured booking messages consistently while preserving manual staff replies.

### Voice

- Adapt both realtime tools and the standard turn-based voice path to the same draft service. Retire the separate mutable booking authority in `voiceRealtimeBookingState` through a controlled compatibility path.
- Finalized utterances carry call ID, turn/source ID, and ordering information. Do not patch or confirm from partial ASR or an obsolete turn.
- Read back the exact preview and bind approval to that preview's call/response context. Use playback completion/interruption evidence where available; a generated transcript alone does not prove a readback was heard. If uncertain, repeat a short confirmation rather than booking.
- A barge-in or correction invalidates the relevant pending readback/approval context. A late completion/tool result cannot restore the old version.
- Make confirmation a small server operation on stored identifiers; do not require the realtime model to regenerate times, title, service ID, and duration.
- For long provider work, give a truthful pending response and provide a durable status lookup. Do not announce confirmed until the actual receipt exists.

### SMS, WhatsApp, and manual API paths

Pass channel/session/source identity through shared orchestrator calls. Support text selection and preview confirmation without requiring buttons. Preserve STOP/consent handling, issue-scoped escalation, worker deduplication, and existing delivery behavior.

Manual appointment and reschedule endpoints must use the shared scheduling policy/capacity protection. An authenticated staff submit is its own authorized operation; it need not pretend to be a conversational draft. Keep its command/idempotency boundary explicit. Preserve existing cancellation/rescheduling provider linkage and regression-test it.

## 9. File map and implementation phases

### Phase 0 — Establish the baseline and reproduction

Inspect `docs/appointment-booking-regression-2026-09-21.md`, git status/history, migrations, CI, and current deployment process. Capture the running build revision if accessible; otherwise mark it unverified.

Create fixtures for Office Cleaning (240 minutes), known open hours, Africa/Lagos display, and a fixed clock on September 21, 2026. Reproduce malformed output and split date/time turns. Record current provider routing and business/calendar timezone settings; do not change customer configuration merely to satisfy a fixture.

Exit: reproducible tests/fixtures and a concise gap list, with existing fixes accounted for.

### Phase 1 — Domain schema and state transitions

Add schema/migrations, repository methods, typed outcomes, version checks, source-event deduplication, preview binding, command/receipt persistence, and session scoping. Update `db/schema/index.ts` and migration verification as needed.

Likely touchpoints: `db/schema/core-domain.ts`, `db/schema/orchestrator.ts`, `db/schema/voice.ts`, new booking schema/module, `server/orchestrator/pending-actions.ts` compatibility.

Exit: domain/database tests prove stale writes, cross-session access, duplicate transitions, expiry, and recovery state behavior without an LLM.

### Phase 2 — Date resolution and unified availability

Implement deterministic normalization, service resolution/duration, range search, shared scheduling policy, stored offers, and typed provider errors.

Touchpoints: `server/domain/core/native-calendar.ts`, `calendar-booking.ts`, `repository.ts`, `references.ts`, `schemas.ts`, `server/providers/contracts.ts`, `server/providers/calendar/*`, appointment availability API.

Exit: native and provider-backed checks obey the same application constraints and timezone tests, while provider-specific restrictions remain enforced.

### Phase 3 — Reliable commit and reconciliation

Implement atomic ownership, capacity reservation, stable provider keys, persisted commands, safe worker dispatch, receipt recovery, and automation event deduplication. Inspect existing queue retry policies so generic retries cannot repeat uncertain side effects.

Touchpoints: booking service/repository, provider adapters, `worker/index.ts` and jobs, appointment APIs, observability.

Exit: concurrent and fault-injection tests establish one logical booking, no blind creates after uncertain outcomes, and recovery across crashes.

### Phase 4 — Chat orchestration and contact behavior

Replace booking payload generation/reconstruction with intent/patch operations. Keep non-booking pending actions intact. Move authoritative appointment claims into trusted response rendering.

Touchpoints: `server/orchestrator/index.ts`, `tools.ts`, `context.ts`, `test-mode.ts`, AI provider interface only as needed, SMS/WhatsApp services.

Exit: multi-turn scripted conversations preserve fields, answer side questions, handle corrections, and complete bookings through the actual domain service.

### Phase 5 — Widget, history, and staff timeline

Implement preview cards, confirm/change handling, authenticated command transport, history/caching updates, and replay recovery.

Touchpoints: `app/api/widget/messages/route.ts`, widget session/history routes, `server/webchat/schemas.ts`, `repository.ts`, `components/webchat/webchat-widget.tsx` and styles, relevant conversation timeline components. Add routes where cleaner than overloading text messages.

Exit: browser tests prove preview-to-confirm-to-appointment persistence, refresh/reconnect safety, stale-card rejection, and duplicate-click safety.

### Phase 6 — Voice integration

Adapt realtime and turn-based tools, current-call context, preview/readback tracking, final transcript handling, interruption behavior, and status responses.

Touchpoints: `server/voice/realtime-booking.ts`, `realtime-tools.ts`, `realtime-media.ts`, `turns.ts`, `voice/gateway.ts`, associated tests.

Exit: voice state/transport tests prove the same domain transitions and prevent interrupted/stale confirmation. Perform real audio verification where an authorized test environment is available.

### Phase 7 — Full verification, migration rehearsal, and release

Complete the matrix below, run relevant existing suites and full CI, rehearse upgrade against a disposable copy of the old schema, add rollout controls/version logging, and execute authorized staging/live checks.

Exit: a reviewable implementation and report distinguish automated, browser, live-model, live-provider, staging, and production evidence. No production claim without production evidence.

## 10. Acceptance test matrix

Each scenario must assert persisted state and actual command/provider call counts where relevant, not only assistant text. Use real PostgreSQL for locking, constraints, migrations, and command recovery. Keep deterministic tests independent of paid/live providers.

| ID | Scenario | Required outcome |
| --- | --- | --- |
| A01 | Fixed clock Sept 21, 2026; request Sept 23, 2026 | Future date accepted; no model claim that it is past |
| A02 | Service, date, time, timezone arrive in separate turns | Existing fields preserved; ask only for genuinely missing details |
| A03 | 10:00 UTC and 11:00 Africa/Lagos on the same date | Same instant; no false mismatch or new approval loop solely from conversion |
| A04 | Four-hour service at 11:00 Lagos | End is 15:00 Lagos; full interval checked, stored, and previewed |
| A05 | Change date/time/service after preview | Version advances; old preview/offers invalid; fresh check required |
| A06 | Ask duration, location, or price mid-booking | Answer supported facts and retain draft; no unintended mutation/escalation |
| A07 | Request a whole day, morning, or next available | Search a bounded range; return valid stored offers; clarify ambiguity as needed |
| A08 | Ambiguous numeric date, invalid date, missing year, weekday mismatch | Documented resolution or specific clarification; no silent invalid instant |
| A09 | DST gap/fold and a non-hour-offset timezone | Nonexistent/ambiguous time handled explicitly; correct round trips |
| A10 | No slots vs provider timeout/auth/per-calendar error | Distinct truthful outcomes; failure never becomes all-free availability |
| A11 | Hours, buffers, daily limit, existing local/provider conflicts | Consistent policy in availability and commit for native/external paths |
| A12 | Provider pagination or more records than local query cap | No falsely available interval due to truncated conflict data |
| A13 | Cal.com/Calendly event-type/service-duration mismatch | No fabricated end time or silently wrong event type |
| C01 | Typed yes/approved/confirmed after delivered current preview | One confirmation and one appointment; no payload reconstruction |
| C02 | Yes to "should I check?", "is it confirmed?", "yes but noon" | No authorization of the old booking |
| C03 | Old card, expired preview, wrong customer/workspace/session | Rejected without mutation or information leakage |
| C04 | Two yes events, duplicate click, concurrent worker retries | Same command/result; at most one logical appointment/provider create effect |
| C05 | Two customers race for one-capacity slot | One application reservation/booking wins; other receives conflict/alternatives |
| C06 | Concurrent patch and confirmation | Deterministic version/order boundary; no booking of silently changed details |
| C07 | Availability/model result arrives after a correction | Stale response discarded; current draft unchanged |
| C08 | Capability disabled or human takeover after preview | Commit denied according to current policy; no background bypass |
| C09 | Provider/calendar/service settings change after offer | Revalidate correct binding; require renewed preview when material |
| R01 | Crash after command saved but before job enqueue | Durable dispatch/sweeper recovers command |
| R02 | Provider creates event but response times out | Reconcile existing event; no blind second creation |
| R03 | Provider succeeds, DB persistence fails | Recover intended appointment/receipt or tracked compensation; no orphan silently ignored |
| R04 | Crash after appointment saved but before chat response | Retry/status lookup returns same appointment and truthful confirmation |
| R05 | Worker lease expires while old provider call is unresolved | No unsafe second create; unresolved capacity remains protected |
| R06 | Confirmed automation event delivered twice | Downstream effects remain idempotent; no duplicate booking notification caused by replay |
| R07 | Provider returns changed time or non-confirmed status | No false receipt for the original preview; explicit recovery outcome |
| U01 | Widget refresh, cached turn, SSE disconnect, history poll | Booking card and final receipt survive; stale controls remain unusable |
| U02 | Multiple tabs and duplicate/new client event IDs | Server command idempotency survives transport-level differences |
| U03 | Malformed, truncated, nested, or prose-only invalid booking output | No leaked protocol or side effect; safe clarification and typed diagnostic |
| U04 | Same saved contact details repeatedly supplied | No repeated write/"updated" receipt; genuine changes still work |
| V01 | New call after unfinished chat with another date | Call does not inherit the old unconfirmed selection |
| V02 | Interrupted readback followed by ambiguous yes | No commit without valid current preview confirmation |
| V03 | Final vs partial ASR, late tool call, barge-in correction | Only current finalized authorized turn changes state |
| V04 | Voice approval and duplicate realtime tool invocation | Exact stored draft committed once; no reconstruction requirement |
| X01 | Native booking without OAuth credentials | Works with valid native configuration |
| X02 | Configured external provider becomes unavailable | Typed error/recovery; no silent native booking |
| X03 | SMS/WhatsApp approval and unrelated STOP/human takeover | Booking service works; existing channel/consent controls preserved |
| X04 | Existing manual booking, reschedule, cancellation, listing | Existing workflows pass and cannot bypass shared capacity policy |
| M01 | Additive migration on schema containing legacy pending actions | Existing appointments/data preserved; no unconfirmed action auto-executed |
| M02 | Feature disabled/rollback with in-flight new commands | Commands continue recovery; no old/new double execution |

### Exact screenshot regression

Freeze time at `2026-09-21T12:00:00Z`, configure a 240-minute Office Cleaning service, and set known business/calendar hours that include the requested interval. Exercise both matching Lagos configuration and an explicitly configured UTC calendar schedule.

Replay: "I want to book an office cleaning appointment" -> "Sep 23, 2026, 11:00 AM (Africa/Lagos)" -> supply only any genuinely missing required location/contact information -> confirm the server preview.

Expected: no "past date" claim, no lost date, no UTC demand, no repeated unchanged contact receipt, exactly one appointment from `2026-09-23T10:00:00Z` to `2026-09-23T14:00:00Z`, and a receipt rendered in the customer's chosen zone. Preserve the required location. Also test the Sept 30 / `10 am` / `10 am UTC` correction sequence and confirm only the final intended instant.

### Live model and live provider evaluation

Keep three kinds of evidence separate:

1. Scripted planner and deterministic domain tests prove invariants under controlled inputs.
2. A live-model harness with a fake/test calendar proves actual extraction and conversation behavior without external booking side effects. Include paraphrases, typos, split turns, questions, corrections, and approvals. Log model/provider/version and parameters; judge tool/state traces as well as text.
3. Dedicated live provider and real-audio smoke tests prove integrations and transport behavior in authorized test environments.

Use a versioned evaluation set covering at least the core screenshot flow, range search, correction, timezone conversion, side question, repeat approval, and voice interruption. Run each live-model scenario at least three times. Require zero unauthorized/duplicate/false-confirmation outcomes and successful completion of all core flows before declaring release readiness. If a run fails, preserve it as a regression fixture, fix the cause, and rerun the affected set. Passing finite evaluations is evidence, not a guarantee of perfect model behavior.

### Commands and test environment

Follow `.github/workflows/ci.yml` for the disposable PostgreSQL/environment setup. Configure required values without exposing secrets. Verify the target database is disposable before migrations or suites that delete workspaces.

Run focused suites during development, then the complete relevant checks:

```sh
npm run db:migrate
npm test
npm run typecheck
npm run build
npm run test:voice-readiness
npm run test:deployment
npm run verify:deployment
```

Add a dedicated booking browser test command using the existing Playwright conventions and wire it into CI. Retain existing browser/Compose checks relevant to the touched code. Do not label fixtures or setup test mode as a live-provider test. Freeze dates in historical regressions; use safely future dates for live tests.

## 11. Observability and operations

Emit structured events for draft updates, normalized date outcomes, availability checks/results, offers, preview preparation/delivery, confirmation accepted/rejected, command ownership, provider attempt/result, reconciliation, and final appointment persistence.

Include trace/request/source-event ID, workspace/conversation/booking-session/call ID, draft/version, preview/slot/command/appointment reference, provider binding, typed result/error, latency, and build revision. Opaque identifiers are sufficient for routine logs; redact contact details, full transcripts, credentials, and raw planner payloads. If invalid-output samples are necessary, use restricted, redacted, bounded diagnostics.

Track booking funnel counts, invalid extraction/repair rate, stale confirmation rate, conflicts, provider errors, confirmation-to-receipt latency, duplicate attempts suppressed, and age/count of uncertain commands. Operational alerts should identify stuck commands and provider-wide failures without escalating ordinary missing details to staff.

Expose enough authenticated diagnostic detail to reconstruct one booking across web, worker, and gateway. Log commit SHA/image revision at startup for each process; verify deployed images, not just local git refs. Do not expose secrets through health endpoints.

## 12. Migration and rollout

1. Add backward-compatible tables/columns and read paths first. Preserve existing PostgreSQL services, volumes, and data. Rehearse migration on disposable data with legacy pending bookings.
2. Add an explicit engine version/rollout assignment for a booking session or workspace. Old and new engines must never both execute the same booking. Changes to the rollout setting apply to new sessions or a controlled handoff.
3. Do not automatically confirm/import legacy awaiting proposals without reliable identity/preview evidence. Prefer expiry or explicit renewed preview. Preserve executed legacy receipts and retain generic pending actions for non-booking actions.
4. Resolve active-call behavior deliberately: drain existing calls on the old revision or use a tested compatibility path. Do not invalidate live voice state accidentally during rollout.
5. Deploy compatible web, worker, and gateway versions plus migrations. Verify actual build revisions and migration status. Ensure all processes understand the new command lifecycle before enabling traffic.
6. Enable in a test workspace first. Run widget and voice smoke tests; verify database appointment, external event where applicable, returned receipt, and one domain event.
7. Expand gradually while observing correctness failures and pending-command age. Use declared monitoring thresholds; stop expansion on duplicate/unauthorized booking or false confirmation.
8. Rollback stops new sessions entering the new engine. Keep reconciliation workers and new schema available for existing commands. Do not restore old booking execution over an uncertain new-engine command or delete persisted evidence.

Known external-provider limitations must be explicit in the release report. Lack of credentials for an advertised provider means its live verification remains outstanding, not that it passed.

## 13. Definition of done and handoff report

Do not declare the remediation complete merely because prompts improved or unit tests passed. Provide:

- Implemented schema, shared service, channel integrations, provider changes, recovery worker, UI/history behavior, and migration/rollback runbook.
- A brief architectural decision record identifying the state owner, confirmation binding, resource/capacity semantics, date/timezone rules, and provider capability matrix.
- Test results mapped to the matrix, with deterministic, PostgreSQL, browser, live-model, live-provider, and real-audio coverage distinguished.
- Evidence of one persisted appointment and matching receipt/event for the fixed screenshot flow, plus duplicate/race/timeout recovery tests.
- Deployed revision evidence when deployment is performed; otherwise exact release commands/checks and outstanding access or authorization needs.
- Explicit residual limitations, skipped checks and reasons, and any unresolved operational recovery cases.
- A concise final summary of changes, verification, migrations/configuration, rollout status, and remaining work. Never report an external deployment or live booking that was not actually performed.

## 14. Reference documents

Recheck current primary documentation when implementing provider-specific behavior:

- Google free/busy response and per-calendar errors: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Google event creation and client-supplied IDs: https://developers.google.com/workspace/calendar/api/guides/create-events
- Microsoft event resource and transaction IDs: https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0
- Existing repository regression note: `docs/appointment-booking-regression-2026-09-21.md`
- Existing CI and deployment checks: `.github/workflows/ci.yml`, `scripts/verify-deployment-db.mjs`, `docker-compose.yml`, `compose.selfhost.yaml`

Provider guarantees must come from the actual API contract and tests, not assumptions carried over from another adapter.

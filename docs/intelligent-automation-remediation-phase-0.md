# Intelligent Automation Remediation — Phase 0 Product Contract and Verified Baseline

**Date:** 2026-09-20  
**Repository:** `videoxq-dev/AI-Caller`  
**Observed implementation baseline:** `main` commit `2c09266c90137dff3d3f640dbda1d92ad4233fe8` (read-only DeployOS database preflight).  
**Status:** Product contract agreed; documentation reconciliation in progress. No remediation runtime behavior is claimed as implemented by this document.

This document supersedes conflicting *remediation-scope* statements in the 2026-09-19 recovery plan and older MVP roadmaps. Existing security, carrier acceptance, consent, financial reconciliation, and data-retention gates remain in force.

## Locked product decisions

1. **One configured AI agent per workspace.** Existing agent identity, knowledge, instructions, voice settings, qualification and server tools remain the default conversational experience. No workflow is required for ordinary inbound AI service.
2. **One AI Caller-managed phone number per workspace.** Keep the current hosted Telnyx purchase, lifecycle, voice+SMS binding, registration and billing model. Do not build multiple-number acquisition, endpoint A/B assignments, sender fallback across hosted numbers, per-number list, or multi-number migrations. Other already supported channels (WhatsApp and web chat) remain separate channel integrations.
3. **One structured Automation Builder, not a drag-and-drop DAG canvas.** A common index, editor and run history cover deterministic automations and optional conversational workflows. No separate deterministic-automation product or page.
4. **No editable execution-mode picker.** Built-in recipes declare their validated execution structure. Custom workflows derive their classification from registered triggers, actions and explicit bounded AI task stages. A badge may explain Deterministic, AI-assisted or Hybrid; a user's mode selection never authorizes an otherwise unavailable tool or AI call.
5. **Agent capabilities are registered backend actions.** AI Agent settings govern the default agent-wide allowed tool set; a conversational workflow may narrow the allowed set for its objective. Backend validation/authorization applies even to forged planner output; UI configuration is not the executor.
6. **Conversational workflows are optional, situational objectives for the one agent.** At each inbound turn, match trigger and deterministic conditions; choose at most one primary objective using explicit priority and conflict policy. If none matches, use the agent's default instructions/capabilities. Do not launch a second response job for the same inbound turn or allow unrestricted workflow-to-workflow invocation.
7. **An AI tool call is a business action, not a call to a workflow.** The shared availability, booking, contact, qualification, consent, messaging and escalation services remain authoritative. A successful domain mutation durably emits a typed event (such as `APPOINTMENT_CONFIRMED`); matching independent deterministic workflows can then send an eligible confirmation, schedule a reminder or notify staff.
8. **AI for interpretation, code for exact execution.** Static reminders, delays, threshold checks, template rendering and staff notifications should make zero LLM calls. Bounded AI task execution is for natural-language interaction and interpretation. Persist idempotent tool results, event/run histories and usage.
9. **SMS and WhatsApp readiness remain distinct.** SMS uses the current single managed sender, approved campaign/use-case, exact registration, recipient consent and pre-send policy checks. WhatsApp proactive sends require current approved Meta templates where applicable; add a WhatsApp-only template lifecycle. No per-message SMS-template approval product.
10. **Preserve existing users and business data.** Retain legacy automation settings, executions and queued reminders through additive migration and single-writer cutover; do not replay history by default.

## Product ownership model

| Surface | User manages | Backend owner |
|---|---|---|
| AI Agent | Identity, instructions, knowledge, default capabilities, actual status and private tests | Agent service + policy-enforced AI task runner |
| Automations | Recipes, custom triggers/conditions, optional objectives, permitted actions, schedules, messages, publication and run history | Typed event registry, matcher, immutable versions, action executor, scheduler |
| Settings → Phone & Messaging | The existing single managed number, separate voice/SMS status and optional registration | Existing telephony and SMS policy services |
| WhatsApp Templates | Templates, variables, submission/review state and usage | Existing Meta integration + new template lifecycle |
| Inbox / Contacts / Appointments | Human handoff, verified contact data, bookings, outcome visibility | Shared business domain; event/outbox on committed mutations |

**Example:** An inbound call starts one agent turn; an eligible VIP conversational objective may replace the default objective for that turn, not start another agent. The agent calls `CHECK_AVAILABILITY` and `BOOK_APPOINTMENT` through registered backend actions after customer selection. The booking service confirms and commits `APPOINTMENT_CONFIRMED`. The confirmation/reminder workflows execute separately without another conversational response or unnecessary LLM call.

## Explicit changes to the September 19 recovery plan

- Delete its D02 multiple-number decision and replace D03/D08/D09 routing assumptions with one hosted number plus separate existing digital integrations. Do **not** implement its `channel_endpoints` table or phone-number A/B backfill solely for prospective multi-number support.
- Remove multi-number migration waves M1–M3 as drafted, PRs 1–3 multi-number delivery and PR 8 multi-number compliance generalization, as well as tests S01/S04 dependent on numbers A and B. Preserve exact-workspace phone ownership, signed webhooks, single-sender readiness and channel provenance where already present.
- Remove free execution-mode selection from builder step 3. The system derives mode from validated workflow structure; explain any AI cost to users.
- Make default agent conversations independent of installation of New Customer Inquiry or New Patient Intake recipes; conversational recipes narrow or specialize the default mission.
- Keep shared business actions distinct from workflow invocation. Actions may emit business events; events activate independently configured workflows.
- Retain the original plan's immutable workflow versions, safe migration, event-outbox, bounded execution, execution history, typed conditions, scheduling, message approval and idempotency constraints.
- Existing plan references to `GET /api/phone-numbers` pagination, per-number registration routes, default hosted sender and per-number release/renewal are **out of scope** for this remediation. Do not accidentally modify the current singleton contracts.

## Phase delivery order and acceptance

| Phase | Deliverable | Observable acceptance |
|---|---|---|
| 0 | Reconciled scope, current repository inventory and documented existing operational gates | Docs agree on one agent/one number/optional conversational objectives and mode derivation; baseline does not overclaim live CI/deployment |
| 1 | Agent service, registered action/policy contracts, real status/capabilities | Agent answers without workflow; disabled tool rejected server-side; status survives refresh |
| 2 | Bounded multi-step AI task runner | Customer inquiry → real availability → customer choice → exactly one booked appointment → truthful verbal confirmation |
| 3 | Typed events, durable scheduler, workflow versions and legacy compatibility | One booked event activates one permitted confirmation/reminder; cancellation/reschedule invalidates stale sends; deterministic run makes zero LLM calls |
| 4 | Unified structured builder for deterministic custom workflows | Owner creates/tests/publishes threshold notification and sees exactly one auditable run |
| 5 | Optional conversational workflows, priority/conflict handling | VIP gets VIP objective, ordinary caller gets default agent; one primary objective/response per turn |
| 6 | WhatsApp templates, existing single-sender SMS and cross-channel policy | Only eligible approved sender/template delivers; stop, human takeover and consent rechecks suppress disallowed sends |
| 7 | Migration/rollback, cost reconciliation, regression and production acceptance | Exact head passes documented automated gates; real provider acceptance separately evidenced |

**Build sequencing:** Phase 0 is documentation/verification only. Do not modify running DeployOS, carrier assets, billing data, credentials or production-like data as part of this PR.

## Repository evidence (observed on 2026-09-20)

- Latest commit returned by GitHub repository commit search: `2c09266c90137dff3d3f640dbda1d92ad4233fe8`; the earlier recovery plan's `5d96e9a...` is a historical planning baseline, **not** the current observed main.
- The repo's `package.json` exposes `npm test`, `npm run typecheck`, `npm run build`, `npm run db:migrate`, `npm run test:voice-readiness`, `npm run test:deployment`, and milestone browser scripts `test:browser`, `test:browser:m4` through `test:browser:m10`.
- [CI run 35525177979](https://github.com/videoxq-dev/AI-Caller/actions/runs/35525177979), cited by Issue #28 for the disposable SCRAM rehearsal, has a successful primary job covering migrations, tests, typecheck, build, Compose/restore rehearsals, browser suites and screenshot upload. Its Telnyx read-only smoke job was **skipped**. This run is not evidence of live DeployOS volume migration, Telnyx acceptance or a test of this documentation branch. The connected GitHub workflow-run lookup did not return a run for the currently observed `2c09266c...` commit; do not attribute that CI run to this commit without verifying its head SHA.
- [Issue #28](https://github.com/videoxq-dev/AI-Caller/issues/28) is OPEN: existing live DeployOS volume inventory, backup/restore proof, actual SCRAM cutover and data-integrity acceptance remain outstanding. CI on disposable data is insufficient.
- [Issue #31](https://github.com/videoxq-dev/AI-Caller/issues/31) is OPEN and explicitly depends on #28: durable gateway route, actual Standard/Realtime calls, restart checks and real cost-to-credit reconciliation remain outstanding.
- [Issue #24](https://github.com/videoxq-dev/AI-Caller/issues/24) is OPEN: last recorded restricted Telnyx 10DLC/toll-free reads were 403. PR #25 is merged, but live approved outbound SMS, delivery, STOP, billing and sender assignment remain unaccepted. Do not treat voice availability as SMS readiness.
- PRs [#27](https://github.com/videoxq-dev/AI-Caller/pull/27) and [#29](https://github.com/videoxq-dev/AI-Caller/pull/29) are closed, unmerged draft PRs; inspect current main rather than treating those branches as active pending changes.
- `docs/issue-24-telnyx-release-gate.md` already correctly says PR #25 is merged. Do not reintroduce the September 19 plan's stale claim that this line still needs correction.

## Verification still required before Phase 0 authoritative close

- Verify the documentation PR head's GitHub Actions run on the exact SHA; a prior run on a different commit is not a pass for the PR.
- Verify current `main` SHA has not advanced before merging and rebase or reconcile any divergent documentation.
- Document a sanitized *read-only* deployment inventory only after the operator can run the exact script on the real DeployOS host; the GitHub checkout cannot inspect its private volume. No row counts, backup existence or server authentication status may be inferred from CI.
- Continue treating #28 → #31 operational acceptance and #24 live-carrier acceptance as separately tracked release gates, not as silently completed prerequisites.

## Dependencies for Phase 1

1. Inventory existing `/api/agent`, setup/voice configuration, `server/orchestrator/{index,tools,context,usage}`, booking/qualification/consent services and relevant tests at implementation head.
2. Keep the unique one-agent/workspace and one-hosted-number/workspace constraints and existing provider runtime working while adding policy enforcement.
3. Tests first: default agent with zero workflows; disabled/forged action rejected; human takeover race; exact single hosted sender readiness; tool failure and repeated booking attempts.
4. Produce a standalone PR with tests, migration/rollback note if needed, observed CI, and a review across correctness, clarity, architecture, security and performance.

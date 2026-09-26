# AI Caller — Final Production Readiness Acceptance Checklist

**Purpose:** This document is the authoritative final acceptance gate for declaring AI Caller production-ready.

**Status:** Open — production readiness has **not** been accepted until every required item below is verified against the exact release commit and the deployed production-like runtime.

**Scope:** UI/UX, authentication/onboarding, packages and entitlements, workspace/Agency isolation, AI Agent runtime, appointment availability and booking, conversations, contacts/leads, automations, telephony, messaging, Web Chat, integrations, whitelabel publication, security, reliability, billing, deployment, and full end-to-end runtime verification.

## Release rule

AI Caller may be marked **production-ready** only when all of the following are true:

- [ ] 0 Critical findings remain.
- [ ] 0 Required findings remain.
- [ ] CI is green on the **exact commit intended for release**.
- [ ] The deployed production-like runtime passes the final E2E journeys in this document.
- [ ] The returning-user onboarding routing defect is fixed and regression-tested.
- [ ] The Whitelabel layout defect is fixed and regression-tested.
- [ ] Branding publication works in the real client runtime, not only in the editor.
- [ ] Every currently sellable package has been exercised against its actual entitlement matrix.
- [ ] Server-side authorization and entitlement enforcement have been tested independently of UI controls.
- [ ] Availability checking and appointment booking work through both Web Chat and a real inbound call.
- [ ] Billing/credit records reconcile against runtime activity.
- [ ] No unexplained recurring browser, worker, realtime, provider, or server errors remain.
- [ ] Deployment, migration, backup/restore, restart, and rollback readiness are verified.

Live outbound US SMS is a separately named carrier acceptance gate. The application can be production-ready with outbound SMS correctly gated while carrier approval is pending, but live outbound US SMS itself must not be marked accepted until the live/staging Telnyx acceptance criteria in `docs/issue-24-telnyx-release-gate.md` are satisfied.

---

# 1. Current known blockers

These items must be treated as explicit final-acceptance work, not deferred cleanup.

## 1.1 Whitelabel layout defect

Observed on the Whitelabel page:

- Form controls in the left **Brand identity / Client support** card overflow into the right **Client preview / Publication history** column.
- Lower controls/actions do not remain constrained to their owning card/grid column.
- The page must be verified at multiple desktop and narrower viewport widths after the fix.

Acceptance:

- [ ] No inputs, buttons, cards, text, or upload controls overlap adjacent columns.
- [ ] Grid/flex children can shrink correctly without overflow.
- [ ] The editor remains usable at common laptop widths.
- [ ] Responsive behavior stacks or resizes sections cleanly where required.
- [ ] Browser screenshots are captured for accepted viewport sizes.
- [ ] A regression browser test protects the layout behavior.

## 1.2 Returning-user onboarding routing defect

A user who has already completed onboarding must not be routed back into onboarding after a later login.

Acceptance:

- [ ] Genuine new account enters onboarding.
- [ ] Completed account goes directly to the authenticated application on subsequent login.
- [ ] Refreshing an authenticated route does not trigger onboarding.
- [ ] Logout → login after completed onboarding routes correctly.
- [ ] Direct navigation to authenticated routes does not incorrectly redirect.
- [ ] Workspace switching does not incorrectly evaluate another workspace's onboarding state.
- [ ] Interrupted onboarding resumes at the correct incomplete step.
- [ ] Completion state is authoritative server-side and is not dependent only on browser/local state.
- [ ] Browser regression tests cover new, partial, completed, returning, and switched-workspace states.

---

# 2. Whitelabel and branding publication

The editor is not accepted merely because it stores form values. The full publication lifecycle must work in the client-facing runtime.

## 2.1 Draft editing

- [ ] Agency can modify brand name.
- [ ] Agency can modify tagline.
- [ ] Agency can upload logo.
- [ ] Agency can upload app icon.
- [ ] Agency can modify primary color.
- [ ] Agency can modify accent color.
- [ ] Agency can modify client support email.
- [ ] Agency can modify client support URL.
- [ ] Draft can be saved without publishing.
- [ ] Draft survives refresh and a new authenticated session.
- [ ] Invalid file types are rejected with useful errors.
- [ ] Excessive upload sizes are rejected safely.
- [ ] Failed uploads do not leave inconsistent persisted state.

## 2.2 Publication lifecycle

- [ ] Clicking **Publish** creates a persisted published branding version.
- [ ] Published version is immutable.
- [ ] Client-facing runtime reads the published version, not uncommitted draft values.
- [ ] Editing the draft after publication does not silently alter the active client brand.
- [ ] Publishing a second version makes it active.
- [ ] Publication history retains prior versions.
- [ ] Restoring an older version creates a new version rather than rewriting history.
- [ ] Logo/icon assets survive refresh, logout/login, and deployment restart.
- [ ] Agency owner's own AI Caller control center remains branded according to the intended product boundary.
- [ ] Client runtime shows the correct Agency branding after publication.

## 2.3 Mandatory whitelabel runtime scenario

Run this exact scenario:

1. [ ] Create/use an Agency account.
2. [ ] Enter a distinct brand name, tagline, logo, app icon, primary color, accent color, support email, and support URL.
3. [ ] Save draft.
4. [ ] Confirm client platform still uses the previously published branding.
5. [ ] Publish.
6. [ ] Open a client workspace in a clean/incognito browser.
7. [ ] Confirm all published branding appears.
8. [ ] Refresh.
9. [ ] Log out and log in.
10. [ ] Confirm branding remains.
11. [ ] Modify the draft without publishing.
12. [ ] Confirm existing client runtime still shows the published version.
13. [ ] Publish version 2.
14. [ ] Confirm version 2 becomes active.
15. [ ] Confirm publication history contains both versions.
16. [ ] Restore version 1.
17. [ ] Confirm restoration creates a new published version.
18. [ ] Confirm restored branding is shown in the client runtime.

## 2.4 Custom domain

See also `docs/whitelabel-deployos-traefik.md` and `docs/whitelabel-f12-d-live-acceptance.md`.

- [ ] Domain ownership verification works.
- [ ] DNS state survives refresh.
- [ ] Routing state is accurate.
- [ ] TLS/certificate state is accurate.
- [ ] Verified client hostname resolves through the expected edge route.
- [ ] HTTPS works after certificate provisioning.
- [ ] Incorrect DNS produces an actionable state.
- [ ] Re-verification is safe and idempotent.
- [ ] Disconnect removes/deactivates the custom-domain association safely.

---

# 3. Packages, billing, and entitlements

Every currently sellable package must be verified with its real configured entitlement set. UI visibility is not sufficient: backend enforcement is authoritative.

- [ ] Every sellable package can be subscribed/assigned successfully.
- [ ] Correct entitlement set is granted immediately after activation.
- [ ] UI shows/hides/disables features according to entitlements.
- [ ] Backend independently rejects use of unavailable features.
- [ ] Lower plan cannot call higher-plan functionality directly through APIs.
- [ ] Upgrade applies new entitlements without recreating customer data.
- [ ] Downgrade removes future access correctly without corrupting existing records.
- [ ] Workspace limits are enforced.
- [ ] User/sub-user limits are enforced.
- [ ] Agency-only functionality is restricted to eligible Agency accounts.
- [ ] Whitelabel is entitlement-gated correctly.
- [ ] Automation availability/limits correspond to plan configuration.
- [ ] Phone/usage/credits are charged to the correct workspace/account.
- [ ] Credit exhaustion produces controlled behavior.
- [ ] Credits cannot become negative or unaccounted through concurrent usage.
- [ ] Upgrade/downgrade billing events are idempotent.
- [ ] Stripe webhook retries cannot double-apply subscription changes or credits.
- [ ] Failed payment/subscription-state changes produce correct access behavior.
- [ ] Cancellation/end-of-term behavior matches product rules.
- [ ] Billing ledger reconciles with the observed runtime usage for the acceptance account.

For each package, record:

| Package | Expected entitlements | UI verified | API/server enforcement verified | Upgrade/downgrade verified | Billing verified | Result |
|---|---|---:|---:|---:|---:|---|
| Package 1 | TODO from authoritative package config | [ ] | [ ] | [ ] | [ ] | Pending |
| Package 2 | TODO from authoritative package config | [ ] | [ ] | [ ] | [ ] | Pending |
| Package 3 | TODO from authoritative package config | [ ] | [ ] | [ ] | [ ] | Pending |

Replace the placeholder package rows with the actual package names and authoritative entitlement matrix from the release code/config before sign-off.

---

# 4. Workspace and Agency isolation

- [ ] Workspace creation works where the package permits it.
- [ ] Workspace switching works throughout the application.
- [ ] Contacts are tenant-isolated.
- [ ] Conversations are tenant-isolated.
- [ ] Appointments are tenant-isolated.
- [ ] Automations are tenant-isolated.
- [ ] AI Agent configuration is tenant-isolated.
- [ ] Phone numbers are tenant-isolated.
- [ ] Integrations are tenant-isolated.
- [ ] Billing and credits are tenant-isolated.
- [ ] Whitelabel configuration is Agency-owned and cannot be mutated by an ordinary client workspace.
- [ ] Agency-created client workspaces inherit only intended template/configuration.
- [ ] One client's branding cannot affect another client.
- [ ] Cross-workspace resource IDs are rejected server-side.
- [ ] Archive/delete/update operations cannot cross tenant boundaries.

Required evidence includes explicit cross-tenant authorization tests; UI observation alone is insufficient.

---

# 5. AI Agent runtime

The intended architecture remains:

- The **AI Agent** owns conversational intelligence.
- **Registered backend business actions** perform authorized operations.
- **Automation workflows** own deterministic business workflows and optional situation-specific conversational objectives.
- Server-side capability policy is authoritative.

See `docs/intelligent-automation-remediation-phase-0.md` and `docs/phase-1-agent-foundation-acceptance.md`.

Acceptance:

- [ ] ACTIVE agent responds.
- [ ] PAUSED agent does not independently answer.
- [ ] DRAFT agent is not unintentionally exposed.
- [ ] Agent identity persists.
- [ ] Agent instructions persist.
- [ ] Business knowledge loads correctly.
- [ ] Tool availability matches configured capabilities.
- [ ] Disabling a capability prevents server-side execution even if a model attempts the tool call.
- [ ] Agent answers ordinary business inquiries.
- [ ] Contact update works.
- [ ] Lead qualification works.
- [ ] Availability checking works.
- [ ] Appointment booking works.
- [ ] Human escalation works.
- [ ] **When Unsure** behavior is respected.
- [ ] Manual Human → AI restoration stays with AI unless a new legitimate escalation occurs.
- [ ] Tool failure produces truthful conversational behavior.
- [ ] AI never claims a consequential action succeeded before receiving authoritative success.
- [ ] Consequential actions are idempotent.
- [ ] Model/tool retries do not create duplicate appointments or duplicate side effects.

---

# 6. Appointment availability and booking

This is a mandatory release gate because availability and booking have previously suffered runtime regressions.

See `docs/appointment-booking-e2e-remediation-plan.md`, `docs/appointment-booking-regression-2026-09-21.md`, and `docs/booking-followup-2026-09-22.md`.

## 6.1 Availability

- [ ] "Do you have anything Friday?" works.
- [ ] Explicit calendar date works.
- [ ] Relative date works.
- [ ] Date + time works.
- [ ] No-availability state is correct.
- [ ] Returned slots match authoritative calendar availability.
- [ ] Timezone handling is correct.
- [ ] Past dates are rejected.
- [ ] Invalid/ambiguous dates trigger useful clarification.
- [ ] Calendar provider failure produces a controlled truthful response.
- [ ] Same behavior works through Web Chat.
- [ ] Same behavior works during a real inbound call.

## 6.2 Booking

- [ ] Customer expresses booking intent.
- [ ] Required information is collected.
- [ ] Availability is checked authoritatively.
- [ ] Customer confirms the intended slot.
- [ ] Booking is created exactly once.
- [ ] Appointment exists in the database.
- [ ] Calendar event exists where the integration is enabled.
- [ ] Customer receives accurate confirmation.
- [ ] Conversation/transcript records the correct result.
- [ ] Booking failure is never described as success.
- [ ] Retried tool calls do not duplicate the appointment.
- [ ] Concurrent requests do not incorrectly reserve the same exclusive slot.
- [ ] Cancellation works.
- [ ] Rescheduling works.

A successful acceptance run must demonstrate the complete sequence:

**request → availability → slot selection → confirmation → exactly one persisted appointment → accurate customer confirmation**

---

# 7. Inbox and conversations

- [ ] Conversation list loads reliably.
- [ ] Correct conversation opens.
- [ ] Opening a chat initially scrolls to the newest message.
- [ ] New incoming messages auto-scroll appropriately.
- [ ] User can inspect older messages without being forced back to the bottom.
- [ ] Typing/processing state is accurate.
- [ ] Message ordering is correct.
- [ ] Voice transcript ordering is correct.
- [ ] Refresh preserves sequence.
- [ ] AI/human attribution is correct.
- [ ] Human takeover works.
- [ ] Human → AI restoration works.
- [ ] Issue/message-specific handoff does not permanently lock unrelated requests away from the AI.
- [ ] Recordings/attachments load where supported.
- [ ] Failed sends expose actionable retry behavior.
- [ ] Duplicate provider events do not create duplicate messages.

---

# 8. Contacts and leads

- [ ] Create contact.
- [ ] Edit contact.
- [ ] Search contact.
- [ ] Inbound interaction creates/links the correct contact where appropriate.
- [ ] Phone normalization works.
- [ ] Duplicate identity handling is safe.
- [ ] Qualification data persists.
- [ ] Qualification score/status updates correctly.
- [ ] Conversation links to the correct contact.
- [ ] Appointment links to the correct contact.
- [ ] Consent links to the correct contact.
- [ ] Workspace isolation is verified.

---

# 9. Automations

Deterministic workflows and conversational workflows share registered business actions but have different responsibilities.

- [ ] Create automation.
- [ ] Edit draft.
- [ ] Validate configuration.
- [ ] Test automation.
- [ ] Publish.
- [ ] Published version is immutable.
- [ ] Trigger fires exactly once per event.
- [ ] Conditions evaluate correctly.
- [ ] Scheduled actions execute at the expected time.
- [ ] Paused automation does not execute.
- [ ] Archived automation does not execute.
- [ ] Failed action retries safely.
- [ ] Retry does not duplicate side effects.
- [ ] Execution history is accurate.
- [ ] Relevant entitlement limits are enforced.
- [ ] Deterministic workflow does not invoke AI unnecessarily.
- [ ] Conversational workflow changes the existing agent objective without creating another agent.
- [ ] Default agent behavior continues when no conversational workflow matches.
- [ ] Conflicting conversational workflows resolve according to the intended priority rules.

---

# 10. Phone and voice runtime

- [ ] Managed number belongs to the correct workspace.
- [ ] Inbound call reaches AI Caller.
- [ ] AI answers.
- [ ] Audio is intelligible.
- [ ] No prior interference/noise regression is present.
- [ ] Voice does not unexpectedly change mid-call.
- [ ] Turn-taking is natural enough for the supported receptionist experience.
- [ ] Long conversation remains stable.
- [ ] Business tool invocation during the call works.
- [ ] Availability works during the call.
- [ ] Booking works during the call.
- [ ] Human escalation works during the call where configured.
- [ ] Call terminates gracefully.
- [ ] Recording is stored where configured.
- [ ] Transcript is created.
- [ ] Transcript ordering matches the actual conversation.
- [ ] Credit/usage records are created.
- [ ] Provider errors do not crash the runtime.
- [ ] Realtime gateway survives expected reconnect/retry cases.

See `docs/voice-provider-readiness-v1.md`, `docs/voice-v2-basic-receptionist-acceptance.md`, and `docs/managed-telephony-live-acceptance.md`.

---

# 11. SMS and messaging

Outbound US SMS readiness is independent of unrelated phone capabilities. Voice, booking, and other available functionality must remain usable while outbound SMS carrier approval is pending.

See `docs/issue-24-telnyx-release-gate.md` and `docs/phase-6c-sms-automation-readiness.md`.

- [ ] Inbound SMS works.
- [ ] SMS enters the correct unified conversation.
- [ ] STOP is honored.
- [ ] HELP is handled according to the messaging framework.
- [ ] Consent persists.
- [ ] Transactional and marketing consent remain distinct.
- [ ] AI cannot bypass messaging authorization.
- [ ] Human operator cannot bypass messaging authorization.
- [ ] Scheduled automation cannot bypass messaging authorization.
- [ ] Carrier readiness is checked immediately before dispatch.
- [ ] Outbound SMS from an unapproved number is blocked with a truthful state.
- [ ] Approved number can send SMS in a live/staging carrier acceptance test.
- [ ] Telnyx delivery result is reconciled.
- [ ] Message usage is billed correctly.
- [ ] Retry/idempotency prevents duplicate sends.

## Separate carrier acceptance gate

Application production readiness may be accepted while the external Telnyx administrative/approval dependency remains pending **only if**:

- [ ] Outbound SMS is correctly feature-gated.
- [ ] The application does not claim an unapproved number can send outbound US SMS.
- [ ] SMS registration state is surfaced accurately.
- [ ] Voice and unrelated capabilities remain available.
- [ ] The unresolved live-carrier acceptance item is documented explicitly.

Live outbound US SMS itself remains **not accepted** until the provider acceptance evidence is completed.

---

# 12. Web Chat

- [ ] Widget loads from a clean browser.
- [ ] New customer can start a conversation.
- [ ] Returning conversation behavior is correct.
- [ ] AI answers knowledge questions.
- [ ] Availability works.
- [ ] Booking works.
- [ ] Contact capture works.
- [ ] SMS consent capture works.
- [ ] Chat initially positions at the latest message.
- [ ] New messages scroll appropriately.
- [ ] Mobile/responsive layout works.
- [ ] Widget cannot access another workspace.
- [ ] Published Agency branding appears where intended.
- [ ] Unpublished draft branding does not appear.

---

# 13. Integrations

For each integration advertised as supported in the release:

- [ ] OAuth/connect flow works.
- [ ] Token refresh works.
- [ ] Disconnect works.
- [ ] Invalid/expired credentials produce actionable state.
- [ ] Reauthorization works.
- [ ] Provider outage does not corrupt local state.
- [ ] Integration remains workspace-isolated.
- [ ] Secrets are not unnecessarily exposed to the browser.

Calendar-specific:

- [ ] Availability reflects provider state.
- [ ] Appointment creation reaches the provider.
- [ ] Calendar event details match the AI Caller appointment.
- [ ] Provider-side failure does not produce false booking success.

---

# 14. Security acceptance

- [ ] Cross-workspace IDOR tests pass.
- [ ] Agency/client isolation tests pass.
- [ ] Role enforcement is server-authoritative.
- [ ] Entitlement enforcement is server-authoritative.
- [ ] Billing-management permissions are enforced.
- [ ] Integration-management permissions are enforced.
- [ ] Webhook signatures are verified where required.
- [ ] Input schemas reject malformed/untrusted payloads.
- [ ] Uploaded assets are validated.
- [ ] No secrets appear in browser bundles.
- [ ] No secrets appear in logs.
- [ ] Provider secrets are not returned through APIs.
- [ ] Public endpoints have appropriate abuse/rate controls.
- [ ] Public Web Chat endpoints cannot mutate privileged resources.
- [ ] Data-layer access remains parameterized/ORM-safe.
- [ ] Dependency audit is completed and relevant findings are reviewed.
- [ ] Authentication/session boundaries survive direct API attempts, not only browser flows.

---

# 15. Reliability and performance

- [ ] No unbounded database queries in release-critical paths.
- [ ] Major list endpoints are bounded/paginated where required.
- [ ] Dashboard remains responsive with realistic data volume.
- [ ] Inbox remains responsive with substantial conversation history.
- [ ] Retry workers are bounded.
- [ ] Scheduled-job retries are safe.
- [ ] Duplicate webhooks are idempotent.
- [ ] Process restart does not lose durable work.
- [ ] Provider timeout paths are controlled.
- [ ] AI provider timeout paths are controlled.
- [ ] Realtime failures recover or fail safely.
- [ ] Browser has no unexplained recurring console errors.
- [ ] Server logs have no unexplained recurring errors.
- [ ] Worker/queue logs have no unexplained recurring errors.
- [ ] No obvious N+1 regression is present in hot paths.
- [ ] Large allocations or blocking work have not been introduced in realtime paths.

---

# 16. Deployment and operational readiness

- [ ] Fresh production build succeeds.
- [ ] All migrations succeed from the current production-like DB state.
- [ ] Backup is taken before migration rehearsal.
- [ ] Restore rehearsal succeeds.
- [ ] CI passes on the exact release commit.
- [ ] No uncommitted production-only fixes exist.
- [ ] Environment validation succeeds.
- [ ] Application health endpoint works.
- [ ] Database health works.
- [ ] Worker/queue health works.
- [ ] Realtime/voice gateway health works.
- [ ] HTTPS works.
- [ ] WebSocket upgrade works.
- [ ] Restart survives correctly.
- [ ] Rollback procedure is documented and verified.
- [ ] Runtime logs are accessible.
- [ ] Errors are observable.
- [ ] Production deployment does not depend on undocumented manual mutations.

---

# 17. Mandatory final E2E runtime journeys

These journeys must run against the deployed production-like runtime on the exact release candidate.

## 17.1 Positive journey

Run the following as one coherent acceptance journey:

1. [ ] Sign up with a clean account.
2. [ ] Complete onboarding.
3. [ ] Enter the application successfully.
4. [ ] Verify assigned package and entitlements.
5. [ ] Configure/activate the AI Agent.
6. [ ] Provision/connect the managed phone capability required for the release test.
7. [ ] Place a real inbound call.
8. [ ] Ask a business-information question.
9. [ ] Complete lead/contact handling where applicable.
10. [ ] Ask for availability.
11. [ ] Select a real available slot.
12. [ ] Book the appointment.
13. [ ] Verify exactly one appointment is persisted.
14. [ ] Verify provider calendar event where configured.
15. [ ] Verify the customer receives an accurate confirmation.
16. [ ] Verify relevant automation/event handling executes exactly once.
17. [ ] Verify conversation, recording, and transcript are present and ordered correctly.
18. [ ] Verify runtime usage is reflected in billing/credits.
19. [ ] Log out.
20. [ ] Log back in.
21. [ ] Confirm onboarding is **not** shown again.
22. [ ] Continue through Web Chat.
23. [ ] Verify Web Chat availability/booking path.
24. [ ] For an Agency acceptance account, publish branding.
25. [ ] Open a client runtime in a clean browser.
26. [ ] Verify the published brand appears.
27. [ ] Verify the final billing/credit ledger reconciles with the executed journey.

## 17.2 Negative-boundary journey

1. [ ] Use a lower-plan account.
2. [ ] Attempt restricted UI features.
3. [ ] Attempt the same restricted actions directly through the API.
4. [ ] Confirm the backend rejects unauthorized use.
5. [ ] Disable an AI Agent capability.
6. [ ] Ask the AI to perform the disabled action.
7. [ ] Confirm the server blocks it and the AI responds truthfully.
8. [ ] Attempt to book an unavailable/past/invalid slot.
9. [ ] Confirm no false success and no unwanted appointment.
10. [ ] Simulate/reproduce a provider timeout/failure path.
11. [ ] Confirm no duplicate or phantom side effect.
12. [ ] Attempt outbound SMS while carrier readiness is absent.
13. [ ] Confirm dispatch is blocked and state is truthful.
14. [ ] Attempt a cross-workspace resource operation.
15. [ ] Confirm the server rejects it.
16. [ ] Retry duplicate provider/webhook events.
17. [ ] Confirm idempotency prevents duplicate records/actions.

---

# 18. Verification record

Complete this section for the release candidate.

| Evidence | Value |
|---|---|
| Release commit SHA | Pending |
| Release branch/tag | Pending |
| CI run | Pending |
| Deployed environment | Pending |
| Deployment timestamp | Pending |
| Database migration result | Pending |
| Backup/restore rehearsal | Pending |
| Positive E2E journey | Pending |
| Negative-boundary journey | Pending |
| Web Chat booking | Pending |
| Real inbound-call booking | Pending |
| Whitelabel publish/runtime | Pending |
| Package entitlement matrix | Pending |
| Cross-tenant security tests | Pending |
| Billing reconciliation | Pending |
| Live outbound US SMS | Separate carrier gate / Pending unless approved |
| Remaining Critical findings | Pending |
| Remaining Required findings | Pending |

## Final verdict

Use exactly one final verdict after completing the evidence above:

- **Approve — Production ready**
- **Request changes — Issues must be addressed**

Do not approve based only on passing tests or CI. Approval requires verified runtime correctness, clear product behavior, sound architecture, security, entitlement enforcement, billing integrity, acceptable performance, deployability, and completion of the mandatory E2E journeys.

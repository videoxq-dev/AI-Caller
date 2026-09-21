# Owner acceptance record — September 21, 2026

This is the business owner's original completed Phase 1 checklist, preserved verbatim below as reported before remediation. Failure labels represent observed behavior, not independent validation of the suspected cause. Statuses will be retested against a new deployed commit. Do not overwrite this record with a blank form.

---

# Phase 1 — AI Agent foundation: dev-server acceptance and feedback

**Purpose:** Verify the merged implementation after deployment to the production-like dev server. Engineering acceptance is not the same as user sign-off. The phase is finally closed only when the owner reviews actual end-user behavior, records feedback, and explicitly signs off.

**Product scope:** One agent and one managed Telnyx number per workspace. There is no requirement to configure any automation for ordinary conversations. Existing contact, booking, qualification, consent, SMS, WhatsApp and human escalation services remain authoritative. The AI Agent Test tab is a *private simulator*; its booking/escalation results are not live provider acceptance.

## Deployment prerequisites and recording

- Confirm the exact merged `main` commit and release/deployment ID. Record the hash below. Only deploy the reviewed, green exact head.
- Preserve the DeployOS PostgreSQL volume and complete Issue #28's backup/authentication preflight before the first migration or redeploy. CI's disposable PostgreSQL run is not proof that the existing volume has been migrated safely.
- Check the `0022_agent_activation_backfill.sql` migration was applied exactly once. Existing actively serving workspaces should not revert to DRAFT. A genuinely new agent remains DRAFT.
- Confirm OpenAI/Telnyx realtime credentials, rates and runtime routes separately under Issue #31. A skipped protected Telnyx job is not live carrier evidence. Issue #24's Telnyx 10DLC administrative restriction is a separate SMS carrier blocker.
- Do not post API keys, full customer phone numbers, unredacted transcripts or personal data in feedback.

**Deployment record:** Git SHA: b45e3c87c59675843e152124a112b47fdfbd2c74 · deploy ID: ______ · deployment date/time + timezone: Monday, 21 September 2026 6:16 AM WAT · relevant app/worker/gateway versions: ______ · DB backup reference: ______ · migration result: ______

## Acceptance tests

Record **PASS / FAIL / BLOCKED / NOT TESTED / N/A** for each case. Include the channel, screenshot/call reference, and a brief observation.

| ID | Test action | Expected observed result | Status / evidence |
| --- | --- | --- | --- |
| P1-01 | Create a new workspace and configure Mia; reload AI Agent before activation. | One saved agent, correct name/instructions, DRAFT persists; there is no fictitious online status. |✅|
| P1-02 | Open Capabilities; enable answer, contact update, lead update/qualification, availability, booking, escalation; save and reload. | Settings persist, reflect the actual catalog and do not create a second agent. |✅|
| P1-03 | Activate Mia; leave all automations unconfigured; ask a normal business question over Web Chat and, if available, an inbound phone call. | Mia answers from saved knowledge without a workflow, with one coherent contact/conversation history. |✅|
| P1-04 | Ask an appointment question, supply the needed contact details, check availability, approve a slot, book. | Availability is sourced from the connected calendar, booking is persisted once; Inbox, Appointments and contact history agree. No invented slot or confirmation. |❌ - Agent couldn't book appointment.|
| P1-05 | Disable **Book appointments** only, save, reload, and request a booking again on Web Chat and phone (Standard/Realtime where enabled). | Mia does not create an appointment or claim one exists, even when the model tries the action. Availability checking may still work if enabled. |❌|
| P1-06 | Disable Check availability, save, and request open slots. | No fabricated availability; no successful availability tool action until re-enabled. |❌|
| P1-07 | Disable Update contacts, ask Mia to record a new contact field, then re-enable it and retry with an explicitly provided field. | Disabled: no AI-driven mutation. Enabled: actual contact details update without changing unrelated fields. |✅ No AI change when disabled. Number updated when enabled, no chat feedback of completion|
| P1-08 | Configure required qualification questions; speak with Mia and answer them one by one. Then disable Qualify leads and retry. | Scores/completion come from the existing server qualification logic, not an invented LLM score; disabled capability cannot complete qualification. |✅|
| P1-09 | Ask for a human while escalation is enabled, then retry disabled. | Enabled: correct human ownership and Inbox trace. Disabled: no unauthorized escalation or false live-call-transfer promise. |✅ no feedback of handoff, just a silent transfer.|
| P1-10 | Pause Mia; send a Web Chat message and call the managed number; reload the page. | PAUSED persists; no new AI conversation reply or AI business action; an inbound phone call receives an unavailable notice rather than starting a Realtime session. Incoming messages/calls are still auditable. |✅|
| P1-11 | Resume Mia and retry the same question; select **Return to draft** on the AI Agent Overview and reactivate. | ACTIVE persists and responding resumes. DRAFT suppresses automatic replies. Private AI Agent test remains distinct from live behavior. |✅|
| P1-12 | Edit Mia's name, tone, instructions, voice and guardrails *after disabling booking*; reload. | Ordinary editing preserves the booking restriction and all other capability settings. |❌ Appointment booking not working|
| P1-13 | Verify messaging consent and readiness separately: opt out/STOP, then try outbound SMS on an unapproved managed sender. | Revocation remains effective; no SMS bypass of Telnyx registration, number readiness or consent, whether an agent capability is on or off. Report carrier blockers as BLOCKED, not passed. |✅|
| P1-14 | Open the AI Agent page on desktop and mobile after real conversations exist. | Status, number state, SMS readiness, usage credits and recent activity are actual workspace data; no fake contact lists, credits, phone numbers or test-passed badges, and no horizontal overflow. |✅ Tapping a chat in Inbox mobile view doesn't open the chat|
| P1-15 | Switch to another workspace and test with a staff member. | No cross-workspace agent/policy leakage; unauthorized roles cannot change status or tool permissions. |❌ Can't create new workspace. Functionality not available|
| P1-16 | Check call recording/transcript, conversation ownership and appointments before and after the update. | Existing artifacts, consent/recording behavior, and core domain workflows are preserved. |✅|

**Expected exception:** A business may have an ACTIVE agent while its managed number is not active or outbound SMS is still pending approval. The UI must show those as distinct readiness states.

## Feedback form — complete once per defect or confusing experience

- Case ID(s): ______
- Status: PASS / FAIL / BLOCKED / NOT TESTED / N/A
- Feature / channel / voice technology: ______
- Expected behavior: ______
- Actual behavior or exact error: ______
- Steps to reproduce (without sensitive data): ______
- Impact: critical security/data loss · core flow blocked · inconsistent UX · cosmetic / optional
- Frequency: once · intermittent · every attempt
- Date/time and timezone: ______
- Redacted evidence: screenshot / Inbox ID / call ID / trace ID / console or provider log reference: ______
- Carrier/deployment dependency (if blocked): ______
- Preferred behavior / proposed change: ______
- Retested after fix? result and commit: ______

## End-user sign-off

**Engineering verification:** exact commit ______ · CI run ______ · local/live limitations ______.

**Business-owner acceptance:** [ ] All applicable tests passed or accepted exceptions are recorded. [ ] Blocking defects were fixed and retested. [ ] UI/wording and workflow are acceptable. [ ] I explicitly sign off Phase 1 and authorize Phase 2.

**Owner / date / notes:** Most features are dialed in but system couldn't book an appointment regardless of the capability status. Note that no 3rd party calendar was integrated but i expected the appointment to be recorded in-app and surfaced on the Appointment page. Check Availability didn't give feedback on whether it checked or not. Another major issue is that the system didn't give feedback on the actions it took. For instance, it didn't inform the customer that their request has been escalated to a human and would be contacted later nor did it inform me if there was an available slot for the chosen days.

An implementation reaching green CI is **engineering-complete**, not final authoritative phase closure. Do not advance to Phase 2 before this sign-off.

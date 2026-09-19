# Issue #24 — Telnyx SMS carrier acceptance and release gate

**Status:** PR #25 stays draft and unmerged while the AI Caller Telnyx account cannot access the 10DLC / toll-free registration endpoints. Passing fixture CI is not proof of production messaging readiness.

## Automated checks before carrier acceptance

- Verify the PR head and run CI on that exact commit: migrations, Vitest, typecheck, production build, Milestones 3–10 browser suites and screenshots. Milestone 5 exercises NOT_REGISTERED, PENDING, REJECTED and READY using guarded database/carrier fixtures, not real carrier approval.
- Inspect code paths for owner-only paid registration submission, workspace scoping, hidden carrier IDs, signed inbound webhooks, bounded reconciliation, uncertainty after a provider timeout, consent events, campaign scope and immediate pre-dispatch rechecks.
- Preserve independent inbound voice and inbound SMS behavior when outbound registration is not ready. Do not enable or advertise outbound messaging from a pending/rejected number.
- Check the deployed Settings SMS registration form, reminder banner, hosted opt-in evidence and mobile screenshots. No live Telnyx POSTs or number orders should occur in CI.

## After Telnyx clears the administrative restriction

1. Confirm the GitHub environment `AI-Caller` still contains `HOSTED_TELNYX_API_KEY`; do not print or copy it to logs, issues or PR descriptions. Verify the live account has the intended Telnyx billing, messaging profile and US registration privileges. Re-run `node scripts/telnyx-readonly-smoke.mjs` using the existing securely configured environment. Confirm **all three** reads (messaging profiles, 10DLC brands and toll-free verification requests) return HTTP 200. The read-only script deliberately reports unavailable endpoints as UNVERIFIED; its exit status alone does not prove compliance access.
2. In a controlled deployed environment, submit a real registration with a consenting test business and a US managed sender of each supported type: 10DLC local and toll-free. Review any Telnyx submission charges before invoking the mutating endpoints. Use real business and consent evidence; never submit invented identity data or test production recipients who have not consented.
3. Check submission idempotence and persisted **carrier** brand, campaign or verification identifiers. For 10DLC, confirm the brand identity, campaign approval and exact number-to-campaign assignment. For toll-free, confirm a Verified request containing the exact managed number. An API response indicating only request creation, review pending, or an unassigned campaign must never set READY.
4. Exercise pending, rejected, remediation/resubmission, and eventual approved states through Settings and the global non-blocking banner; confirm inbound voice still answers and inbound SMS is received while outbound approval is withheld where Telnyx permits inbound messaging.
5. For an approved sender, obtain transactional opt-in through the hosted Web Chat form or documented phone consent, then send a real appointment message through the AI orchestrator and a separate staff-originated message through the same outbound service. Confirm Telnyx accepted both, signed delivery callbacks reconcile the existing message IDs, and hosted credits and usage events are recorded once. Confirm an actual booked-appointment reminder may use the same applicable transactional consent.
6. Send a STOP from the consenting test recipient. Check the persistent contact consent and append-only event history; verify subsequent AI, staff and scheduled sends to that recipient are blocked. Check a separately opted-in marketing flow, where approved, without allowing a transactional selection to disguise a promotion. Confirm START behavior separately without reactivating marketing consent automatically.
7. Revoke or reject sender approval in a controlled test, if the carrier permits, and confirm a previously cached READY runtime cannot send. Confirm unknown carrier send outcomes are not blindly retried, and ambiguous brand/campaign creation is escalated for manual carrier reconciliation rather than repeating a potentially billable POST.

## Evidence required on PR #25 before changing from draft

Record the exact tested commit, deployed environment, sanitized Telnyx resource references, number type (not full customer numbers), registration and assignment states, consenting test-recipient evidence, dated delivery and STOP callback identifiers, billing and event counts, screenshots, and applicable CI run links. Redact sensitive business identity, API keys, full numbers, message bodies and contact data. Update Issue #24 with the observed results.

**Release decision:** Keep Issue #24 open and PR #25 draft until the above real-carrier acceptance is complete. Automated fixture tests and authentication-only reads are necessary but insufficient. Re-run CI on the final PR head; merge only after required code findings and carrier verification are resolved.

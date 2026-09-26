# Production readiness acceptance ledger

This ledger records verification against `docs/final-production-readiness-acceptance-checklist.md`. It is an evidence index, not a substitute for the checklist. Mark a gate accepted only after its specified check has passed on the exact release commit and, where required, the deployed production-like runtime.

## Baseline and first remediation slice

- Baseline `main`: `b2fcfa13b32f27d9397c1735a43a63a38b5438ee`. CI run [#1992](https://github.com/videoxq-dev/AI-Caller/actions/runs/36242393038) passed, but the checklist remains open.
- Returning-user defect: sign-in defaults to `/welcome`; the server resolves the current workspace's persisted `liveCompletedAt` and redirects completed workspaces to `/dashboard`. The existing explicit `returnTo` behavior remains in place. Settings now has a real account sign-out action; a new CI browser scenario exercises new, partial, completed, refresh, actual sign-out/login, and workspace switching. The first CI run exposed a test-only direct sign-out POST without the Origin Better Auth requires; the test now uses the product control. **Pending:** corrected CI and deployed verification.
- Whitelabel layout: editor and preview grid tracks may shrink, and the sections stack at laptop widths. The existing F12-C browser test now checks viewport overflow and actual card/control bounds at 1440, 1280, 1100, 900, 760, 620 and 390 pixels and captures screenshots. **Pending:** CI execution and visual inspection of screenshots on the candidate.
- Package rows in the authoritative checklist now name all six purchase SKUs. **Pending:** confirmation of configured sellable IDs and exercise of each actual entitlement matrix in the release environment.
- Local checks for the initial slice: TypeScript typecheck passed; production build passed; nine focused tests passed with required test environment values; both changed browser scripts passed Node syntax checks. Typecheck and syntax checks also passed after the sign-out follow-up. The database-backed browser scenarios could not be run in this local checkout because PostgreSQL and Chromium are unavailable. This is **not** runtime acceptance.

## General Settings remediation

- The General tab now reads the active workspace's persisted business profile and role. Business name and timezone save atomically through `PATCH /api/business`; other profile fields, including concurrent updates by another administrator, and onboarding completion are preserved. Staff mutations through that API, business hours, and the setup server action require a management permission.
- Removed General controls and channel switches that had no persisted behavior, as well as a search box with no search action. The save confirmation appears only after the server returns the persisted profile. A new CI browser scenario covers refresh, workspace switching, retained profile fields, and staff denial through both the UI and direct APIs. **Pending:** exact-head CI browser execution and deployed recheck.

## Acceptance gates still open

| Gate | Required evidence | State |
|---|---|---|
| Returning-user and Whitelabel defects | CI browser tests and screenshots, deployed recheck | Pending |
| General Settings persistence | CI browser regression, role isolation, deployed recheck | Pending |
| Brand publication and custom domain | [#111](https://github.com/videoxq-dev/AI-Caller/issues/111): F12-E/F client auth and portal are not implemented; current custom hosts serve a holding page. Clean client session, draft/publish/restore cycle and verified DNS/TLS route remain required | **Required blocker** |
| Packages and billing | Every configured sellable SKU, direct API denials, purchase/reversal/idempotency, ledger reconciliation | Pending |
| Workspace and Agency isolation | Cross-tenant mutation attempts, role and purchaser ownership checks | Pending |
| AI Agent and automations | Capabilities and retries, pause/resume, history and truthful failure behavior | Pending |
| Booking | [#44](https://github.com/videoxq-dev/AI-Caller/issues/44): Web Chat and real inbound-call availability and exactly-once booking, calendar and database match; [#48](https://github.com/videoxq-dev/AI-Caller/issues/48): staff reconciliation for uncertain appointment changes | **Required blocker** |
| Inbox, contacts and Web Chat | Browser journeys, ordering, consent and client isolation | Pending |
| Voice, integrations and messaging | Live inbound call and provider states; outbound US SMS tracked separately | Pending |
| Security and reliability | Direct API probes, audit, bounded queries, logs and failure injection | Pending |
| Deployment and operations | Exact-head CI, migration/backup/restore, health, restart and rollback rehearsal | Pending |
| Final E2E journeys | Checklist sections 17.1 and 17.2 against deployed candidate | Pending |

## Release decision

**Request changes — Issues must be addressed.** No deployed release candidate or complete acceptance evidence exists yet for this checklist. Do not infer production readiness from the baseline CI result or the local build. Live outbound US SMS remains its own carrier acceptance gate under `docs/issue-24-telnyx-release-gate.md`.

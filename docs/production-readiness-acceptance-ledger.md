# Production readiness acceptance ledger

This ledger records verification against `docs/final-production-readiness-acceptance-checklist.md`. It is an evidence index, not a substitute for the checklist. Mark a gate accepted only after its specified check has passed on the exact release commit and, where required, the deployed production-like runtime.

## Baseline and first remediation slice

- Baseline `main`: `b2fcfa13b32f27d9397c1735a43a63a38b5438ee`. CI run [#1992](https://github.com/videoxq-dev/AI-Caller/actions/runs/36242393038) passed, but the checklist remains open.
- Returning-user defect: sign-in defaults to `/welcome`; the server resolves the current workspace's persisted `liveCompletedAt` and redirects completed workspaces to `/dashboard`. The existing explicit `returnTo` behavior remains in place. A new CI browser scenario exercises new, partial, completed, refresh, logout/login, and workspace switching. **Pending:** CI execution and deployed verification.
- Whitelabel layout: editor and preview grid tracks may shrink, and the sections stack at laptop widths. The existing F12-C browser test now checks viewport overflow and actual card/control bounds at 1440, 1280, 1100, 900, 760, 620 and 390 pixels and captures screenshots. **Pending:** CI execution and visual inspection of screenshots on the candidate.
- Package rows in the authoritative checklist now name all six purchase SKUs. **Pending:** confirmation of configured sellable IDs and exercise of each actual entitlement matrix in the release environment.
- Local checks for this slice: TypeScript typecheck passed; production build passed; nine focused tests passed with required test environment values; both changed browser scripts passed Node syntax checks. The database-backed browser scenarios could not be run in this local checkout because PostgreSQL and Chromium are unavailable. This is **not** runtime acceptance.

## Acceptance gates still open

| Gate | Required evidence | State |
|---|---|---|
| Returning-user and Whitelabel defects | CI browser tests and screenshots, deployed recheck | Pending |
| Brand publication and custom domain | Clean client session, draft/publish/restore cycle, verified DNS/TLS route | Pending |
| Packages and billing | Every configured sellable SKU, direct API denials, purchase/reversal/idempotency, ledger reconciliation | Pending |
| Workspace and Agency isolation | Cross-tenant mutation attempts, role and purchaser ownership checks | Pending |
| AI Agent and automations | Capabilities and retries, pause/resume, history and truthful failure behavior | Pending |
| Booking | Web Chat and real inbound-call availability and exactly-once booking, calendar and database match | Pending |
| Inbox, contacts and Web Chat | Browser journeys, ordering, consent and client isolation | Pending |
| Voice, integrations and messaging | Live inbound call and provider states; outbound US SMS tracked separately | Pending |
| Security and reliability | Direct API probes, audit, bounded queries, logs and failure injection | Pending |
| Deployment and operations | Exact-head CI, migration/backup/restore, health, restart and rollback rehearsal | Pending |
| Final E2E journeys | Checklist sections 17.1 and 17.2 against deployed candidate | Pending |

## Release decision

**Request changes — Issues must be addressed.** No deployed release candidate or complete acceptance evidence exists yet for this checklist. Do not infer production readiness from the baseline CI result or the local build. Live outbound US SMS remains its own carrier acceptance gate under `docs/issue-24-telnyx-release-gate.md`.

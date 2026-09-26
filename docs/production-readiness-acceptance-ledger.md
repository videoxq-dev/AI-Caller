# Production readiness acceptance ledger

This ledger records verification against `docs/final-production-readiness-acceptance-checklist.md`. It is an evidence index, not a substitute for the checklist. Mark a gate accepted only after its specified check has passed on the exact release commit and, where required, the deployed production-like runtime.

## Baseline and first remediation slice

- Baseline `main`: `b2fcfa13b32f27d9397c1735a43a63a38b5438ee`. CI run [#1992](https://github.com/videoxq-dev/AI-Caller/actions/runs/36242393038) passed, but the checklist remains open.
- [PR #110](https://github.com/videoxq-dev/AI-Caller/pull/110) merged as `d42bf1d1a7d1a9bdc48f4bccdba8ea2526397577`. Its exact-head [CI run](https://github.com/videoxq-dev/AI-Caller/actions/runs/36249105021) passed. The post-merge `main` run and deployed verification are separate gates.
- Returning-user defect: sign-in defaults to `/welcome`; the server resolves the current workspace's persisted activation marker or legacy active/paused agent and redirects completed workspaces to `/dashboard`. Explicit `returnTo` still works. Settings has a real sign-out action. CI exercised new, partial, completed, refresh, actual sign-out/login, and switched-workspace states. **Pending:** deployed verification, including a legacy account.
- Whitelabel layout: editor and preview grid tracks shrink and sections stack at laptop widths; asset file inputs stay inside their cards. F12-C CI checked viewport overflow and actual card/control bounds at 1440, 1280, 1100, 900, 760, 620 and 390 pixels. The uploaded [viewport screenshots](https://github.com/videoxq-dev/AI-Caller/actions/runs/36248465977) were inspected at desktop, laptop and mobile widths. **Pending:** deployed recheck.
- Package rows in the authoritative checklist now name all six purchase SKUs. **Pending:** confirmation of configured sellable IDs and exercise of each actual entitlement matrix in the release environment.
- Local checks for the initial slice: TypeScript typecheck passed; production build passed; nine focused tests passed with required test environment values; both changed browser scripts passed Node syntax checks. Typecheck and syntax checks also passed after the sign-out follow-up. The database-backed browser scenarios could not be run in this local checkout because PostgreSQL and Chromium are unavailable. This is **not** runtime acceptance.

## General Settings remediation

- The General tab now reads the active workspace's persisted business profile and role. Business name and timezone save atomically through `PATCH /api/business`; other profile fields, including concurrent updates by another administrator, and onboarding completion are preserved. Staff mutations through that API, business hours, and the setup server action require a management permission.
- Removed General controls and channel switches that had no persisted behavior, as well as a search box with no search action. The save confirmation appears only after the server returns the persisted profile. A new CI browser scenario covers refresh, workspace switching, retained profile fields, and staff denial through both the UI and direct APIs. **Pending:** exact-head CI browser execution and deployed recheck.

## Acceptance gates still open

| Gate | Required evidence | State |
|---|---|---|
| Returning-user and Whitelabel defects | CI browser tests and screenshots passed on #110; deployed recheck | Deployment pending |
| General Settings persistence | CI browser regression, role isolation, deployed recheck | Pending |
| Brand publication and custom domain | [#111](https://github.com/videoxq-dev/AI-Caller/issues/111): F12-E/F client auth and portal are not implemented; current custom hosts serve a holding page. Clean client session, draft/publish/restore cycle and verified DNS/TLS route remain required | **Required blocker** |
| Packages and billing | Every configured sellable SKU, direct API denials, purchase/reversal/idempotency, ledger reconciliation | Pending |
| Workspace and Agency isolation | Cross-tenant mutation attempts, role and purchaser ownership checks | Pending |
| AI Agent and automations | Capabilities and retries, pause/resume, history and truthful failure behavior | Pending |
| Booking | [#44](https://github.com/videoxq-dev/AI-Caller/issues/44): Web Chat and real inbound-call availability and exactly-once booking, calendar and database match; [#48](https://github.com/videoxq-dev/AI-Caller/issues/48): staff reconciliation for uncertain appointment changes | **Required blocker** |
| Inbox, contacts and Web Chat | Browser journeys, ordering, consent and client isolation | Pending |
| Voice, integrations and messaging | Live inbound call and provider states; [#57](https://github.com/videoxq-dev/AI-Caller/issues/57) live Meta WhatsApp template and consent journey; outbound US SMS tracked separately | Pending |
| Security and reliability | Direct API probes, audit, bounded queries, logs and failure injection | Pending |
| Deployment and operations | Exact-head CI; [#28](https://github.com/videoxq-dev/AI-Caller/issues/28) live existing-volume SCRAM and backup/restore; [#31](https://github.com/videoxq-dev/AI-Caller/issues/31) durable gateway routing and billing reconciliation; health, restart and rollback rehearsal | **Required blocker** |
| Final E2E journeys | Checklist sections 17.1 and 17.2 against deployed candidate | Pending |

## Release decision

**Request changes — Issues must be addressed.** No deployed release candidate or complete acceptance evidence exists yet for this checklist. Do not infer production readiness from the baseline CI result or the local build. Live outbound US SMS remains its own carrier acceptance gate under `docs/issue-24-telnyx-release-gate.md`.

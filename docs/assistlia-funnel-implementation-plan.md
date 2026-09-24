# Assistlia funnel implementation plan

Status: implementation in progress. The revised **AI Caller / Assistlia Funnel and Copywriter Product Brief** supplied September 24, 2026 is the commercial source of truth. The existing technical remediation contract remains authoritative for runtime behavior. This plan is an implementation sequence, not a declaration that an upsell is ready to sell.

## Product model and boundaries

There is **one application** with five offers and six purchasable SKUs:

| Offer | License product code | Brief-defined commercial difference |
| --- | --- | --- |
| Front end: Core | CORE | One business; 15,000 starter credits; one configured AI agent; native appointments and Core channels |
| OTO 1: Unlimited | UNLIMITED | Up to ten businesses; up to five staff per business; expanded calendars, up to two imported website/file knowledge sources per business, widgets, automations and reporting; an additional 15,000 promotional credits |
| OTO 2: Performance | PERFORMANCE | Advanced custom workflows, AI reactivation and conversion/revenue intelligence |
| OTO 3: Agency | AGENCY_50, AGENCY_100 | Agency console and 50 or 100 managed client businesses, with a client-capacity expansion path |
| OTO 4: Whitelabel | WHITELABEL | Custom domain, product name, brand assets and client-facing branded experience |

“Unlimited” is not unlimited hosted AI, voice, messaging or provider consumption. Credits remain metered. There is still **one AI Caller-managed Telnyx number and one configured AI agent per business workspace** under the current runtime contract; none of these SKUs authorizes changing that architecture silently. Automation remains a structured, non-drag-and-drop builder with system-chosen workflow execution, not a user-facing execution-mode selector.

Keep **commercial purchase licenses** separate from the existing PERSONAL/GROWTH workspace billing plan. The latter currently governs seat quotas, whereas the funnel grants access and business capacity to the purchasing account. Do not treat a workspace-level JSON entitlement as an authoritative account-level workspace quota.

A buyer can provide Core as a service to another business, but the Core license still covers one business. Unlimited permits up to ten; Agency has separate 50- and 100-client SKUs. Define effective capacity from **active purchases**, not from the latest webhook or an unvalidated UI selection. OTO entitlements add their documented capabilities; purchasing a later OTO does not implicitly grant every earlier OTO unless that is explicitly part of the commercial offer.

## Delivery method

Deliver vertical slices with tests before implementation, migrations where needed, scoped API/UI updates, an independently reviewable pull request and CI evidence on the exact final head. Do not merge because a subset of checks is green. Distinguish CI fixture/browser coverage from live Telnyx, Meta, DeployOS and payment acceptance.

### F1 — Catalog and safe Core defaults (first PR)

- Introduce explicit mapping for Core, Unlimited, Performance, Agency 50, Agency 100 and Whitelabel. Reject conflicting IDs and fail closed on unknown IDs even in development.
- Reconcile the Core starter-credit default and example environment to **15,000**.
- Keep OTO purchase provisioning **disabled** until durable purchase/revocation, quota enforcement and the promised features are complete. Adding an OTO product ID to configuration in F1 does not activate it.
- Record tests for complete mapping, unknown products, empty configuration, ambiguous configuration, Agency capacity variants and credit amounts.
- Deployment caveat: a preexisting STARTER_CREDITS override in DeployOS takes precedence over the new code default. Existing grants must not be silently repeated or backfilled by changing the default.

### F2 — Account-level commercial licensing and entitlements

- Persist purchased SKUs and ownership with an explicit purchasing-user link; reuse the existing idempotent license purchase identity. Distinguish license status from operational availability.
- Define and implement effective entitlement evaluation across a buyer's owned businesses, including package-specific business limits, seat limits, permissions, calendar limits, widgets and advanced feature flags.
- Reconcile active licenses after sale, refund, chargeback, cancellation and reinstatement. One OTO refund must not suspend an otherwise valid Core business or cancel unrelated SKUs. Consider concurrent and out-of-order webhooks and support safe retry of a failed event.
- Grant Core's 15,000 starter credits and Unlimited's extra 15,000 **once per eligible purchase**. Design replay-safe and refund-aware promotional credit handling, with ledger evidence even when credits have already been consumed.
- Enforce account capacity transactionally at workspace creation and agency client provisioning; cannot bypass enforcement through direct API calls, invitations or concurrent requests. Preserve explicitly marked development/admin provisioning and migrate existing user workspaces without silently deleting or suspending them.
- Connect upgrade receipts to the same buyer and expose a transparent purchase/entitlement summary in app and admin surfaces.
- Acceptance: purchase/replay/refund/out-of-order/concurrent tests; capacity boundary tests; permission tests; controlled commerce integration run with real configured product IDs.

### F3 — Core completeness and acceptance

Confirm inbound phone, SMS, WhatsApp, webchat, unified inbox, manually entered services/FAQs/policies (without website/file knowledge imports), contacts, qualification, native scheduling, issue-scoped human handoff, basic recipes, dashboard and starter credits operate as one product. Core must not access external calendar connections. Resolve or explicitly gate the existing live acceptance blockers in Issues #24 (US SMS), #28 (deployment DB), #31 (voice), #44 (booking) and #57 (WhatsApp); #48 affects external-calendar appointment management. “Implemented in CI” is not equivalent to provider-approved live delivery.

### F4–F6 — Unlimited

F4: owner-level ten-business capacity, five-staff seats, access controls, unlimited-supported contacts/history/automation limits and a combined maximum of two website-or-file imported knowledge sources per owned business with bounded file sizes and operational safeguards. F5: multiple Google/Microsoft/Calendly/Cal.com calendar connections, service/staff routing and connected-calendar appointment management. F6: multi-widget lifecycle, reusable workflows/configurations, integrations and enhanced reporting; the 15,000 bonus credits arrive through F2.

### F7–F9 — Performance

F7: typed workflow conditions, branches, delays, follow-ups and suppression/cancellation with quotas, consent and auditability. F8: consent-aware segmentation, AI reactivation and message/call handling with rate limits and deduplication. F9: conversion events, source attribution, recovered opportunities and revenue intelligence with defensible denominators and reports. The current six-trigger/four-action sequential builder is the starting point, not evidence that Performance is complete.

### F10–F11 — Agency

F10: agency owner/client hierarchy, capacity SKUs, delegated team and client access, client provisioning and central dashboard. F11: cloning with safe secret exclusion, templates, unified agency reports and additional-capacity purchase behavior.

### F12 — Whitelabel

Domain ownership verification and TLS/routing; branding isolation for client app, login, widget, reports and permitted emails; safe defaults and custom-domain rollback. Brand customization must not change platform security or license isolation.

### F13 — Entire purchase funnel and release

Exercise Core-only, each OTO combination, Agency 50 to 100, Whitelabel, duplicate IPNs, disputed/refunded purchases, old-account upgrades, credit top-ups and business-limit edges. Match customer-facing copy and actual purchase receipts to enabled features; only declare an offer commercially ready after exact-head CI, browser acceptance and relevant real integration checks.

## Cross-cutting acceptance rules

- Authorize on the server on every sensitive action; UI visibility does not enforce product boundaries.
- Reuse existing tenancy, agent, booking, messaging, automation, ledger and admin services rather than building parallel implementations.
- Product IDs and credentials must be configured outside source; never derive access from an IPN product name or marketing copy.
- Preserve legacy buyer data and existing credits during migration; reconcile discrepancies explicitly before enforcement.
- Never silently grant an unfinished OTO, add multi-number purchasing, or replace native Core scheduling with an external-calendar dependency.

## Imported knowledge clarification — September 24, 2026

The founder subsequently clarified the initial broad Unlimited Knowledge wording: **Core has no imported website/file knowledge upload; an active Unlimited purchase allows at most two imported sources per business, counting website imports and uploaded files together**. Manually entered service, product, FAQ and policy knowledge in Core remains available. On Unlimited refund, keep previously imported content accessible to staff for deletion but block additions and edits until eligible access returns; never silently delete business data. This later product instruction controls the importer source count, not the earlier general wording in the copywriter brief.\n
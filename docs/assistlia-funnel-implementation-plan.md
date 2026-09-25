# Assistlia funnel implementation plan

Status: implementation in progress. The revised **AI Caller / Assistlia Funnel and Copywriter Product Brief** supplied September 24, 2026 is the commercial source of truth. The existing technical remediation contract remains authoritative for runtime behavior. This plan is an implementation sequence, not a declaration that an upsell is ready to sell.

## Product model and boundaries

There is **one application** with five offers and six purchasable SKUs:

| Offer | License product code | Brief-defined commercial difference |
| --- | --- | --- |
| Front end: Core | CORE | One business; 15,000 starter credits; one configured AI agent; native appointments and Core channels |
| OTO 1: Unlimited | UNLIMITED | Up to two total businesses; up to five staff per business; expanded calendars, up to two imported website/file knowledge sources per business, widgets and reporting; an additional 15,000 promotional credits |
| OTO 2: Performance | PERFORMANCE | Unlocks the existing Automation Builder and custom automations |
| OTO 3: Agency | AGENCY_50, AGENCY_100 | Agency workspace management and 50 or 100 client businesses in addition to the buyer's original workspace, with a client-capacity expansion path |
| OTO 4: Whitelabel | WHITELABEL | Custom domain, product name, brand assets and client-facing branded experience |

“Unlimited” is not unlimited hosted AI, voice, messaging or provider consumption. Credits remain metered. There is still **one AI Caller-managed Telnyx number and one configured AI agent per business workspace** under the current runtime contract; none of these SKUs authorizes changing that architecture silently. Automation remains a structured, non-drag-and-drop builder with system-chosen workflow execution, not a user-facing execution-mode selector.

Keep **commercial purchase licenses** separate from the existing PERSONAL/GROWTH workspace billing plan. The latter currently governs seat quotas, whereas the funnel grants access and business capacity to the purchasing account. Do not treat a workspace-level JSON entitlement as an authoritative account-level workspace quota.

A buyer can provide Core as a service to another business, but the Core license still covers one business. Unlimited permits two total business workspaces, counting the original; Agency has separate 50- and 100-client SKUs, each exclusive of the original business (51 or 101 total owned workspaces). Define effective capacity from **active purchases**, not from the latest webhook or an unvalidated UI selection. OTO entitlements add their documented capabilities; purchasing a later OTO does not implicitly grant every earlier OTO unless that is explicitly part of the commercial offer.

## Frozen completed surfaces

**Phase 6C SMS is closed scope.** Do not change SMS runtime behavior, SMS readiness/registration logic, outbound SMS policy, delivery behavior, or concluded SMS product flows while implementing unrelated funnel or entitlement work unless the founder explicitly reopens SMS scope. If a later feature changes a prerequisite used by an SMS acceptance fixture, adapt only that fixture's external setup as narrowly as necessary; do not change the SMS behavior being verified. Treat unexpected SMS regressions as blockers to the unrelated change, not as permission to redesign SMS.

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

### OTO 1 — Unlimited

The revised funnel brief plus the founder's later clarifications define the implemented Unlimited boundary. Unlimited supports up to two owned businesses including the original, up to five staff per business, removes Core's 500-contact cap, unlocks up to two combined website/file knowledge imports per business, unlocks the existing supported external-calendar connection capability, and grants an additional 15,000 promotional hosted credits. Core retains native in-app scheduling. Unlimited does **not** mean unlimited calendar connections, does not authorize a new multi-calendar architecture, and does not unlock non-calendar BYOP; other customer-supplied provider integrations are reserved for Whitelabel.

Once the Core 500-contact maximum and Unlimited uncapped-contact entitlement are verified and merged, the founder has confirmed the agreed **Core and OTO 1 Unlimited implementation scope is complete**. Do not infer additional Unlimited engineering work from the superseded F4/F5/F6 milestone language.

### OTO 2 — Performance

The founder's September 24 clarification locks Performance to the **existing Automation Builder and custom automations**. Do not build new advanced workflow logic as part of this upgrade. AI reactivation, segmentation, conversion/revenue intelligence, additional follow-up systems, and other previously described Performance expansion features are deferred.

Core and Unlimited retain the built-in automation recipes. An active `PERFORMANCE` purchase is required to access the Automation Builder, create or edit custom workflows, publish/resume them, inspect their custom-workflow activity, and execute published custom workflows. Later OTO purchases such as Agency or Whitelabel do not implicitly grant Performance. If Performance is refunded or otherwise inactive, preserve custom workflow definitions and history but stop dispatching or executing them until Performance access is restored.

**Frozen-feature guard — Phase 6C SMS:** Phase 6C SMS readiness and its acceptance behavior are concluded. Do not modify SMS runtime behavior, SMS workflow behavior, or the Phase 6C acceptance script while implementing unrelated funnel/entitlement work unless the founder explicitly reopens SMS scope. If a new cross-cutting entitlement causes a Phase 6C regression, fix the new entitlement or generic test scaffolding outside the SMS feature boundary; do not rewrite the concluded SMS workflow to accommodate the new work.

### Agency workspace capacity and management clarification — September 24, 2026

The founder approved a revised capacity model: **Unlimited covers two total owned workspaces (original plus one additional); Agency 50 contributes 50 client workspaces on top of the original workspace, and Agency 100 contributes 100 client workspaces on top of the original**. A single Agency 50 or Agency 100 purchase therefore yields server-side total-owned capacity of 51 or 101 respectively, while the Agency management dashboard shows **client usage** excluding the original. **Agency capacity is stackable by active purchase receipt**: Agency 50 + Agency 100 yields 150 client slots (151 total including the original), and two active Agency 50 receipts yield 100 client slots. Inactive/refunded licenses contribute no capacity; removing one stacked receipt removes only its own allowance, and existing over-limit businesses remain available but cannot be expanded.

The Agency-only Workspaces page lists purchaser-owned workspaces, displays client usage and available slots, creates workspaces through the existing transactionally limited API, and opens an existing business via the existing workspace switch endpoint. The existing quick workspace switcher stays available to all packages; Unlimited can create its second business there without access to the Agency page. Access to the Agency inventory API and page must be rechecked against an active Agency license, even if the user directly navigates to the URL. Workspace creation is not restricted solely to Agency.

The workspace-management slice delivered the Agency dashboard and capacity enforcement. The commercial-lifecycle slice below adds JVZoo Agency sale/revocation provisioning. Agency credit allocation, cloning/templates and cross-client reporting remain separate acceptance gates before the broader Agency package is complete; BYOP has since moved to Whitelabel.

### Agency commercial lifecycle clarification — September 24, 2026

Agency 50 and Agency 100 are purchaser-owned add-on licenses anchored to the buyer's active original Core business. A verified Agency purchase grants capacity only; it must not create client workspaces automatically. Each active Agency receipt contributes its purchased client allowance: Agency 50 contributes 50 slots and Agency 100 contributes 100 slots. Multiple active Agency receipts stack, including repeated purchases of the same SKU.

Agency sale, billing, cancellation, explicit reinstatement, refund and chargeback events are reconciled independently from Core. Agency cancellation/refund/chargeback removes only the affected receipt's Agency capacity and does not delete, suspend or reassign existing client workspaces. Effective capacity is always recomputed from the remaining active Agency receipts; for example, removing an Agency 100 receipt while one Agency 50 receipt remains leaves 50 client slots. Existing over-cap workspaces remain intact and further creation is blocked until entitlement once again covers the current count.

Commercial ownership is separate from operational workspace administration. The Agency purchasing account remains the commercial owner of Agency capacity; later delegated-access work may grant agency staff or client administrators operational access without transferring the commercial license. **Delegated Agency/client access must reuse the existing workspace membership and invitation system (`OWNER` / `ADMIN` / `STAFF`) and its seat-limit enforcement rather than introducing a parallel Agency user model.** Agency-specific work should orchestrate which commercially owned workspaces a person is invited to; authorization remains workspace-scoped.

**Agency delegated-access rule:** each additional Agency client workspace may have one delegated client primary user using the existing operational `OWNER` membership role in addition to the Agency purchaser. This client owner does not consume a sub-user seat and does not become the commercial owner. The client owner receives access only to that workspace and cannot access Agency capacity, Agency billing, sibling client workspaces, or the Agency workspace-management console. Additional Agency staff or client staff use the existing `ADMIN` / `STAFF` memberships and continue to consume the workspace's normal seat allowance. Agency itself does not silently grant extra Admin/Staff seats; existing Personal/Growth seat rules and any independently active Unlimited seat entitlement remain authoritative.

**Credit policy (Agency C):** newly created client workspaces receive no Agency-funded credits automatically. Credit top-ups are final and non-refundable under the customer policy. Only the Agency commercial purchaser may buy hosted credits for Agency-managed clients; clients cannot use the platform's checkout to purchase their own credits. Agency credits purchased for resale go to a purchaser-owned pool distinct from the Agency's original business wallet, and the Agency allocates them by auditable, idempotent transfers to each isolated client workspace wallet. Client owners retain read-only access to credit balances, usage and transaction history. Runtime usage remains workspace-scoped rather than drawing directly from the cross-client pool. Payment-provider disputes/chargebacks remain accounting events: any loss is recorded against the Agency pool, even if this causes an Agency pool deficit; previously allocated client credits are not silently clawed back.

**Client feature boundary:** delegated Agency clients receive at most Core-level product features. Agency ownership does not convey Unlimited, Performance, Agency, or Whitelabel functionality to client users or their managed workspace. Additional client users still consume the workspace's own Admin/Staff seat allowance; a delegated primary client OWNER is seat-exempt. Client-facing credit purchases are disabled even though their operational OWNER membership can view the workspace's billing information.

**Provider policy:** non-calendar BYOP is not an Agency feature. Agency workspaces use Assistlia-hosted provider infrastructure. BYOP is reserved for Whitelabel. Unlimited external-calendar access remains its explicit separate entitlement. The legacy Agency BYOP runtime entitlement is deliberately deferred to the Whitelabel upgrade milestone; Agency C must not silently reopen that integration change.

### F10–F11 — Agency

F10: agency commercial ownership, agency owner/client hierarchy, capacity SKUs, delegated agency-team and client access, client provisioning, client-specific credit funding and the central workspace dashboard. Agency workspaces remain on Assistlia-hosted providers; BYOP is not part of Agency. F11: Agency-purchased credit-pool allocation to client wallets (client self-checkout disabled), cloning with safe secret exclusion, templates, unified agency reports and additional-capacity purchase behavior.

### Agency D — reusable client setup and safe cloning

D1 captures only an explicitly allowlisted **Core** configuration: reusable business category/summary/hours, one AI Agent's copy and behavior preferences, manual services/FAQs/policies, and validated built-in recipe configuration. The Agency previews existing workspace content and must explicitly review before publishing an immutable purchaser-owned template version. Source identities embedded in free text require human review; high-confidence credential strings are rejected. Published snapshots never include workspace/customer IDs, members, credits, phone assignments, integration bindings, imported knowledge, workflow definitions, consent, conversation or billing data. Source staff assignment and WhatsApp template approvals are removed from recipe configurations.

D2 creates an additional Agency-owned client through the existing locked workspace-capacity transaction and applies an exact immutable template version in that same transaction. A purchaser-scoped request key makes repeated template creation idempotent, with the application/version recorded for audit. A new workspace starts with its own empty credit wallet, Personal/Core-level setup and a DRAFT AI Agent with booking and SMS actions disabled; copied Core recipe settings stay disabled until destination-specific readiness is completed. Only {{business_name}} is substituted during cloning; unresolved destination-specific placeholders remain pending for onboarding review. Template revisions never change previously created businesses. D3 adds Agency template library/review/editor and template-based client creation UI. D4 provides integrated browser/regression acceptance, preserves Phase 6C SMS and booking runtime, and does not change the deferred Whitelabel BYOP entitlement.

### F12 — Whitelabel

Domain ownership verification and TLS/routing; branding isolation for client app, login, widget, reports and permitted emails; safe defaults and custom-domain rollback. Whitelabel is also the package for non-calendar bring-your-own-provider (BYOP) connections such as customer-supplied AI, telephony or messaging provider credentials. Brand or provider customization must not change platform security, secret isolation or license isolation.

### F13 — Entire purchase funnel and release

Exercise Core-only, each OTO combination, Agency 50 to 100, Whitelabel, duplicate IPNs, disputed/refunded purchases, old-account upgrades, credit top-ups and business-limit edges. Match customer-facing copy and actual purchase receipts to enabled features; only declare an offer commercially ready after exact-head CI, browser acceptance and relevant real integration checks.

## Protected concluded scope — Phase 6C SMS

Phase 6C SMS readiness is **concluded work**. Do not modify SMS runtime behavior, consent rules, registration/readiness logic, delivery handling, provider integration, SMS automation semantics, or established SMS acceptance expectations unless the founder explicitly reopens SMS work.

Later product-entitlement changes must adapt around the concluded SMS implementation. When an unrelated entitlement change affects an SMS browser fixture because that fixture happens to create a custom automation, change only the fixture setup required to satisfy the new entitlement; do not alter SMS product behavior to make the test pass.

## Cross-cutting acceptance rules

- Authorize on the server on every sensitive action; UI visibility does not enforce product boundaries.
- Reuse existing tenancy, agent, booking, messaging, automation, ledger and admin services rather than building parallel implementations.
- Product IDs and credentials must be configured outside source; never derive access from an IPN product name or marketing copy.
- Preserve legacy buyer data and existing credits during migration; reconcile discrepancies explicitly before enforcement.
- Never silently grant an unfinished OTO, add multi-number purchasing, or replace native Core scheduling with an external-calendar dependency.

## Imported knowledge clarification — September 24, 2026

The founder subsequently clarified the initial broad Unlimited Knowledge wording: **Core has no imported website/file knowledge upload; an active Unlimited purchase allows at most two imported sources per business, counting website imports and uploaded files together**. Manually entered service, product, FAQ and policy knowledge in Core remains available. On Unlimited refund, keep previously imported content accessible to staff for deletion but block additions and edits until eligible access returns; never silently delete business data. This later product instruction controls the importer source count, not the earlier general wording in the copywriter brief.\n
## External integration entitlement clarification — September 24, 2026

Core uses AI Caller’s native in-app booking and **cannot connect external calendars**. Unlimited unlocks the existing external calendar integration capability (Google Calendar, Microsoft Outlook, Calendly and Cal.com); it does **not** imply unlimited calendar connections or require new multi-calendar functionality. All other customer-supplied BYOP integrations are reserved for Whitelabel. Meta Embedded Signup for the Core WhatsApp channel and AI Caller-managed hosted voice/SMS/AI services are not treated as Agency BYOP.

## Contact capacity clarification — September 24, 2026

The founder clarified the revised funnel offer: **Core supports a maximum of 500 contacts per business. Active Unlimited removes the contact-count cap.** Enforce this on the server at the shared contact-creation boundary so manual entry and inbound channel-created contacts cannot bypass it. Existing contacts are never deleted after an Unlimited refund or downgrade; if the business is already at or above 500, block only new contact creation until the count is below the Core limit or Unlimited is restored. This clarification completes the agreed Core/Unlimited entitlement scope once verified and merged.

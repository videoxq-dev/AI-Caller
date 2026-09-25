# AI Caller / Assistlia — F12 Whitelabel Implementation and Troubleshooting Plan

**Document status:** Founder-approved implementation contract; F12 implementation in progress. This document does not claim that F12 is implemented.  
**Prepared:** 25 September 2026.  
**Repository:** `videoxq-dev/AI-Caller`; baseline inspected on `main` following merged PR #86.  
**Related plan:** `docs/assistlia-funnel-implementation-plan.md`.  
**Review discipline:** one focused, tested PR at a time; exact-head CI and post-merge verification; distinguish fixture CI from live domain, provider, and deployment acceptance.

> **Authoritative clarification:** This document supersedes the earlier F12 interpretation in which Whitelabel could stand alone on Core, different client businesses could mix hosted/BYOP modes, or the custom domain could replace the purchaser's main AI Caller login. Whitelabel is an **upgrade for an active Agency purchaser**. It adds a branded client-facing platform and a purchaser-wide choice between AI Caller-hosted provider infrastructure and supported BYOP infrastructure. The purchaser continues administering the Agency through the canonical AI Caller domain. Website widget branding is **out of F12 scope**.

---

## 1. Product objective and operating contract

The Agency purchaser resells the existing AI Caller business-assistant service under their own product identity while AI Caller continues operating the application, database, web/worker/voice services, reverse proxy, upgrades, tenant isolation, logging, and platform security. A BYOP purchaser supplies eligible provider accounts, **not** an independent installation of AI Caller. A hosted purchaser uses AI Caller provider accounts and existing purchased-credit funding and Agency allocation. Both use the same hosted AI Caller application and the same Agency-created client workspaces.

### 1.1 Frozen product decisions

1. **Dependency:** Effective Whitelabel requires an active Core purchase, at least one active Agency 50/100 purchase, and an active Whitelabel purchase, all associated with the same commercial purchaser. A Whitelabel receipt without active Agency grants no usable Whitelabel functionality. Whitelabel grants no client-workspace slots by itself. Active Agency receipts continue to stack exactly as already implemented.
2. **Primary account:** The Whitelabel purchasing account and its Agency administrators use AI Caller's canonical application origin, referred to below as `https://app.aicaller.com` **illustratively**; deployment must derive the actual configured canonical URL. They manage Whitelabel, Agency clients, purchases, provider modes and credit allocations there.
3. **Client account:** Delegated client owners and staff enter through the purchaser's approved custom hostname (e.g. `https://app.stratosassist.com`); they see the purchaser's brand and only businesses in which they hold valid workspace membership and which are commercially owned by that purchaser.
4. **One brand per purchasing account** for F12, with one active custom domain per brand as the MVP. Keep the data model capable of future expansion; do not expose a multi-brand or client-custom-domain feature now.
5. **One exclusive infrastructure mode** for the Whitelabel purchaser's *commercially owned business estate* (their original `PRIMARY` workspace plus their Agency client `ADDITIONAL` workspaces): `HOSTED` or `BYOP`. No hosted AI + BYOP SMS combinations, and no Client A hosted + Client B BYOP combinations. The mode is a purchaser/brand-level commercial operating setting, never a client-selected preference or a collection of independent per-capability toggles. Memberships in other purchasers' workspaces do not enter this purchaser's estate. Existing provider route records remain implementation details subordinate to the mode.
6. **Hosted:** AI Caller-backed eligible AI, voice, SMS; Agency purchaser buys hosted credits into the purchaser-owned Agency pool and allocates credits to isolated client workspace wallets. Existing provider, approval, wallet and usage rules continue to apply. A newly created Agency client receives zero automatically allocated credits.
7. **BYOP:** The purchaser connects and authorizes the currently supported third-party provider accounts and per-client sender identities. AI Caller still hosts the software and orchestrates traffic; only eligible upstream provider consumption changes billing responsibility. Never claim support for providers or modalities lacking a working runtime adapter.
8. **No implicit packages:** Whitelabel does not give Unlimited external calendars, imported knowledge, extra staff seats or Performance custom automations to clients; Agency client workspaces remain Core-level unless a separately authorized, explicit product policy is designed and approved. Original purchaser workspace entitlements stay separate from client entitlements.
9. **No widget branding:** Do not modify widget loader, widget appearance, widget embed origin or widget-specific branding in F12. Existing widget functionality/regression testing remains protected.
10. **One managed number/one agent per client workspace** remains the current hosted model. No multi-number purchase or multi-agent architecture. Native booking is retained; carrier approval/real SMS and WhatsApp acceptance remain independent release gates.
11. **Domain configuration:** Customer-facing DNS routing uses an A record to the VPS's **actual** public IP. The A record does not itself establish ownership of the hostname inside AI Caller; require a unique TXT verification proof for claim/transfer, or an equivalently secure automated proof explicitly reviewed and documented. Traefik + ACME/Let's Encrypt supplies and renews TLS certificates; no customer certificate purchase/upload required.
12. **DeployOS desktop is not a runtime dependency.** Traefik and all domain activation/renewal processes run on the VPS, using persistent server-side configuration and storage that survive DeployOS-initiated redeployment.
13. **No automatic cross-mode fallback:** A missing credential, license revocation, provider error or depleted credit wallet must not silently change `BYOP` to `HOSTED` or vice versa. Surface actionable blocked/readiness states and preserve recoverable data.

### 1.2 Example journey

```text
AI Caller canonical app                          Stratos Assist custom app
(purchaser and Agency staff)                     (delegated clients)

Commercial purchaser ── buys Agency+WL ──┐
                     configures brand ───┤
                     verifies domain ────┤
                     selects mode ───────┤
                     funds pool if HOSTED│
                     provisions clients ├──────→ app.stratosassist.com
                     invites client users│         Sheridan Cleaning owner
                     manages client     │         Sheridan Cleaning staff
                     activity from main │         Other clients, isolated
                     AI Caller domain ──┘
```

Purchasers managing a client through the canonical domain do not turn that client's data into purchaser-owned identity data: the commercial purchaser already owns its service relationship, but all data access remains workspace-membership/permission checked. Client access on a custom hostname never exposes purchaser-level Agency/Whitelabel administration, even for a forged URL or direct API call.

### 1.3 Entitlement matrix

| Capability | Core | Agency (with Core) | Agency + Whitelabel | Unlimited / Performance add-on |
|---|---|---|---|---|
| Original business and Core functionality | Yes | Yes | Yes | Independently determined |
| Additional client-workspace slots | No | Per active Agency receipts | Same Agency capacity | No extra slots from Whitelabel |
| Agency dashboard / templates / delegated access | No | Yes | Yes, via canonical domain | Unchanged |
| Agency hosted credit pool/allocations | No | Yes | Yes in HOSTED mode | Unchanged |
| Custom client-facing product brand and domain | No | No | Yes, with effective WL | No |
| Non-calendar provider infrastructure choice | No | Hosted only | Exclusive HOSTED or BYOP | Unlimited is for external calendars only |
| Client's Unlimited/Performance benefits | No | No | No implicit grant | Must not leak purchaser add-ons to clients |
| Agency/Whitelabel administration on client domain | No | No | No | No |

**Compatibility edge:** The existing Core WhatsApp Meta Embedded Signup is already a connected-provider workflow rather than proof that AI Caller owns a global hosted Meta WhatsApp identity. The mode implementation must document how this existing Core channel is treated in both modes, preserve its consent/template approval and not invent a new hosted WhatsApp provider. Similarly, external calendars retain the independently specified Unlimited entitlement and do not become part of the non-calendar hosted/BYOP switch. This is a boundary to encode in mode validation and acceptance, not permission to mix the controlled AI/voice/SMS infrastructure.

---

## 2. Verified repository baseline and known gaps

The following are source-inspected engineering facts, not claims of completed Whitelabel work:

| Existing surface | Relevant location | State / implication |
|---|---|---|
| Product catalog | `server/commerce/products.ts`; `server/env.ts` | `WHITELABEL` SKU and JVZoo ID setting exist; SKU recognition is not proof of lifecycle provisioning. |
| Agency purchases | `server/commerce/agency-lifecycle.ts` | Active receipt identity, purchaser link, capacity and refund/chargeback reconciliation exist; model a Whitelabel lifecycle analog rather than copying unrelated business-capacity logic. |
| Commercial ownership | `db/schema/core.ts`, `workspaceCommercialOwners`; `server/auth/workspace-repository.ts` | Purchaser owns `PRIMARY`/`ADDITIONAL` commercial workspaces independently of operational `OWNER` membership. |
| Delegated Agency access | `server/agency/access.ts`, `server/auth/team-repository.ts` | Reuse workspace OWNER/ADMIN/STAFF membership, invitations and seat enforcement. |
| Hosted credit resale | `server/agency/credit-pool.ts`; Agency credit APIs | Purchaser pool, idempotent allocation to client wallet, client checkout restrictions already implemented. Do not rebuild. |
| Integration entitlement defect | `server/commerce/workspace-entitlements.ts` | Uses exactly one operational `OWNER` to derive purchaser, and grants non-calendar BYOP from `agencyByop`; incompatible with delegated Agency owner and revised Whitelabel contract. |
| Provider route defect/risk | `server/providers/resolver.ts` | Current revoked-BYOP branch can return `HOSTED`; do not allow unconsented route/cost changes in Whitelabel. |
| Provider capabilities | `server/providers/catalog.ts`, `server/providers/ai.ts`, `server/providers/voice/runtime.ts`, `server/providers/sms/runtime.ts` | AI OpenAI/Gemini/OpenRouter; voice Telnyx; SMS Telnyx/Twilio/Plivo. Provider connectivity does not prove carrier authorization or working voice/session flow. |
| Integration storage | `db/schema/integrations.ts`, `server/domain/integrations/repository.ts` | Workspace-scoped encrypted credentials, settings and capability bindings exist. Purchaser-wide BYOP needs an explicitly approved sharing strategy without copying plaintext secrets to client workspaces. |
| Auth | `server/auth/index.ts`, `lib/auth-client.ts`, `app/api/auth/[...all]/route.ts` | Better Auth `^1.7.5`, current single `BETTER_AUTH_URL`, default browser auth client. Needs approved-host and hostname-aware auth integration. Actual installed version must be verified before coding. |
| Invitation / email | `server/auth/workspace-invitation-service.ts`, `server/email/mailer.ts` | Invitations currently use canonical `BETTER_AUTH_URL` and AI Caller wording. Client-domain URLs/branding must be intentional. |
| UI | `components/core-domain/app-nav.tsx`, `app/layout.tsx`, `components/auth-shell.tsx` | Canonical AI Caller identity currently hardcoded; brand only client-domain surfaces, not purchaser's own AI Caller control center. |
| Deployment | `docker-compose.yml`, `docs/deployos-realtime-gateway.md` | Web/worker/gateway/PostgreSQL Compose; Traefik edge is external; do not infer existing live Traefik dynamic provider, cert resolver, ACME volume or DNS configuration without server inspection. |
| External-release gates | Issues #24, #28, #31, #44, #48, #57 | Live SMS, PostgreSQL authentication, realtime voice, booking, reconciliation and WhatsApp must not be signed off from test fixtures. |

**Documentation reconciliation task:** Update `docs/assistlia-funnel-implementation-plan.md` to make Agency a hard Whitelabel prerequisite, remove stand-alone Core+Whitelabel and widget branding from F12, and correct any inconsistent Agency BYOP descriptions. Retain the original plan as historical context only where it conflicts with these later founder decisions. Do not silently rewrite concluded Phase 6C SMS behavior.

---

## 3. Target architecture and trust boundaries

```text
                           CUSTOMER DNS
                app.brand.example A → VPS_IP
                _ai-caller-verify... TXT → proof
                             │
                    HTTPS / Traefik edge
                    (persistent ACME store)
                             │
                    ONE AI Caller Next.js app
       ┌─────────────────────┴─────────────────────┐
       │                                           │
 Canonical origin                            Verified brand origin
 Purchaser control center                    Client-facing portal
 Agency/Whitelabel/commerce                  Brand + allowed client workspaces
       │                                           │
       └─────────────────────┬─────────────────────┘
                  Better Auth / shared users
                  + hostname-bound sessions
                  + membership checks
                  + commercial-owner checks
                             │
                 Existing PostgreSQL / workers
                 Existing hosted / BYOP adapters
```

### 3.1 Authoritative identity inputs

- **Commercial purchaser:** `workspace_commercial_owners.purchaser_user_id`, not `memberships.role='OWNER'`.
- **Authenticated user:** Better Auth session, not hostname, invite query string or brand logo.
- **Brand owner:** purchaser ID on the brand record; one active brand per purchaser.
- **Branded hostname:** normalized, exact-match, active verified domain registry. An unknown hostname must not infer a tenant.
- **Workspace permission:** valid membership and current seat/access requirements; additionally, on a branded hostname, workspace commercial owner must equal brand purchaser and workspace must be within permitted client-facing scope.
- **Commercial permission:** purchaser-only or properly defined Agency staff delegation for non-financial operations; provider keys, mode changes, credit purchases, domain deletion and Whitelabel configuration remain purchaser-authorized by default.
- **Runtime mode:** one authoritative purchaser-level active infrastructure mode for PRIMARY and ADDITIONAL commercially owned workspaces; workspace-specific binding rows cannot override it.

### 3.2 Initial data model (minimum useful persisted state)

Propose migrations only after checking existing audit/assets tables to avoid duplicate structures:

| Table / persisted aggregate | Essential fields and constraints |
|---|---|
| `whitelabel_brands` | ID; unique purchaser ID; product name; tagline; sanitized palette; asset references; support URL/email; draft/published version; timestamps. |
| `whitelabel_domains` | ID; unique canonical hostname; brand ID; claim-verification challenge hash/expiry; state; observed A/AAAA; verification timestamp; TLS state/last checked; activated/disabled timestamps; error classification. |
| `whitelabel_provider_profiles` or existing equivalent | Unique purchaser ID; active mode HOSTED/BYOP; staged mode; selected provider profile references; activation revision; status; operator/time audit. |
| `provider_profile_connections` or existing equivalent | Purchaser-owned encrypted keys/settings and allowed client-workspace bindings; per-client sender/number identifiers where mandatory; no cloned cleartext secrets. |
| Existing immutable audit/event facility | Purchase, branding publication, DNS claim, domain activation/deactivation, mode transition, credential rotation, explicit recovery, administrative changes. |

Use existing secret envelope and storage conventions. Asset objects should be referenced by immutable, ownership-scoped keys; never accept arbitrary private bucket paths or untrusted remote image URLs for privileged assets. Do not create a second credit ledger or duplicate member/invitation model.

### 3.3 Hostname is not workspace authorization

For `app.stratosassist.com`:

1. Reverse proxy forwards an authoritative known hostname; app resolves that exact hostname to ACTIVE brand `Stratos Assist`.
2. Session identifies user U; the hostname identifies brand purchaser P.
3. Requested workspace W must be commercially owned by P and user U must have membership/role authorization for W.
4. Purchaser-wide Agency/Whitelabel/commerce routes are denied on custom hosts regardless of whether U is also the commercial purchaser, except narrowly documented public session/invite services.
5. API, page, server actions, downloads, recordings, web sockets and background task read models use the same effective scoped authorization where applicable. No cross-host leakage via cache keys, shared static responses, active-workspace cookies or `Host` spoofing.

Client business data remains isolated by workspace in the shared database. No per-domain database or service installation.

---

## 4. Milestones, engineering slices and exit gates

### F12-0 — Baseline, decision lock and regression inventory

**Goal:** Stop contradictory requirements from contaminating implementation and establish reproducible verification.

**Tasks**

- Record `main` SHA, current PR/CI state, dependency versions, current DB migration head and running DeployOS/VPS SHA separately.
- Revise original funnel plan and maintain this file in `docs/` as the canonical F12 implementation ledger.
- Inventory: Agency purchaser/secondary OWNER access; SKU ingress and license state machine; wallet/pool flows; integration routes; auth entry points and host-sensitive redirects; email, OAuth callback, webhooks; Traefik version/config ownership/ACME storage. Document precisely what is currently deployed versus only merged.
- Define API errors and status vocabulary for missing Agency, no WL, hostname conflict, DNS mismatch, TLS pending and provider mode not ready.
- Freeze F12 exclusions; capture before screenshots for app, sign-in, invitations, Agency UI, mobile; set up deterministic fixture tenants A/B and a delegated owner.
- Enumerate and retain acceptance commands for Phase 6C, booking, Agency, tests, typecheck, build and migrations.

**Tests first:** Existing Agency delegated-owner fixture + Core/Unlimited/Performance/Phase6C regression baseline.  
**Exit:** Signed decision table, known-current SHA and regression baseline; no unreviewed change to SMS behavior or migration topology.  
**Independent PR:** docs/tests baseline only if implementation starts in separate code slices.

### F12-A — Agency-dependent Whitelabel commercial lifecycle

**Goal:** Only the account that has purchased active Core + Agency + WL can operate WL; purchases may arrive/replay out of order without cross-SKU state corruption.

**Implementation**

- Reuse configured `JVZOO_WHITELABEL_PRODUCT_IDS` and verified ingress, receipt identity, purchaser email/user resolution and existing license status semantics; add a focused `reconcileWhitelabelReceipt` analogous to Agency lifecycle.
- Handle SALE/BILL, duplicate, cancellation, refund, chargeback, explicit reinstatement, old events and unknown ID safely; define unrecognized purchaser/Agency order as retryable or pending per the existing commerce event contract, not fake an active granted feature.
- Compute `effectiveWhitelabel = active CORE && active Agency receipt(s) && active WHITELABEL` for the same purchaser. Preserve a paid but temporarily unusable WL receipt when its Agency prerequisite becomes inactive; do not delete branding, domain claim or BYOP secrets. Capacity stays entirely Agency-derived.
- Whitelabel inactive must disable custom-host access and BYOP execution by audited state transition without cancelling the unrelated Core/Agency or swallowing spent-credit/accounting records. Independent Agency receipts remain stackable; one revoked Agency receipt does not remove eligibility when another remains active.
- Purchaser-only API for status, dependency reason, receipt and effective brand readiness. Only enable the configured SKU for customer sale after downstream F12 gates pass, following F1's disabled-unfinished-OTO principle.

**Tests first:** Product ID collision, forged IPN, duplicate SALE, refund-before-sale, late BILL after refund, two Agency receipts/one refunded, WL refund while Agency active, Agency revocation with WL still active, Core revocation, duplicate purchaser email/name, concurrent event receipt.

**Exit:** Exact receipt-to-entitlement proof, cross-SKU lifecycle isolation, no incremental workspace slots/credits from WL, UI never represents an inactive WL receipt as operationally ready.

### F12-B — Correct commercial-owner and domain-aware authorization

**Goal:** All WL feature checks use commercial purchaser, not membership-count heuristics.

**Implementation**

- Replace the `owners.length !== 1` lookup in `server/commerce/workspace-entitlements.ts` with the authoritative `workspaceCommercialOwners` relationship; preserve specific existing Core/Unlimited/Performance entitlement boundaries by qualifying the *workspace kind* and commercial purchaser, not blindly promoting an Agency client.
- Rename obsolete `agencyByop` to an accurate `whitelabelByop` / `whitelabelProviderChoice` contract; do not grant Agency-only BYOP. Check every write/API route, capability binding, connection test, runtime resolver, worker send and webhook callback, not just Integrations-page visibility.
- Add a centralized `requireEffectiveWhitelabelPurchaser`, `resolveBrandForApprovedHost`, `requireClientWorkspaceOnBrandHost` boundary; ensure managed client OWNER is unable to configure purchaser brand/provider account/Agency credits or see sibling workspaces.
- Keep canonical-host purchaser/Agency administration available independently of active UI workspace selection. Preserve explicitly authorized membership/seat checks for ordinary business actions.
- Review authentication and active-workspace cookie names/scope: across different brand hostnames, stale workspace ID should cause safe workspace selection or 403, never fallback to a disallowed purchaser/other-brand workspace.

**Tests first:** Purchaser + delegated OWNER together; client owner only; Admin/Staff; malicious active-workspace cookie; Agency with/without WL; two brands on same app; direct REST and page route bypass; cached navigation and cross-domain sign-in.

**Exit:** Commercial and operational ownership unambiguously separate; each sensitive entry point requires the same effective authorization.

**F12-B implementation note — purchaser authorization foundation (PR #88)**

- `workspaceCommercialOwners` is authoritative for purchaser identity. The operational `OWNER` role does not confer Agency license, Whitelabel administration, Agency credit purchase/allocation or purchaser provider credentials. A sole-owner fallback remains only for unreconciled historical workspaces without a commercial record.
- Agency-client classification uses the commercial ownership creation timestamp and the purchaser's historical Agency receipt purchase time. An additional workspace created *after* Agency was purchased remains Core-only even when the Agency receipt is later refunded. The purchaser's separate Unlimited second business created *before* Agency purchase remains eligible for its Unlimited seats and contact cap. If historical data was manually imported without reliable purchase/provisioning chronology, reconcile those records explicitly; do not guess a client classification from today's membership counts.
- Whitelabel purchaser administration requires Core, Agency and Whitelabel active receipts anchored to the same commercial primary business; purchaser management is independent of the currently selected workspace. The brand-scoped client-access guard requires an approved brand purchaser ID supplied by a **future verified host resolver**, an Agency-provisioned additional workspace, a delegated client membership and live Whitelabel prerequisites. Purchaser/Agency staff remain on the canonical AI Caller application.
- Non-calendar BYOP remains disabled until F12-G implements an **exclusive estate-wide HOSTED/BYOP mode**. Legacy Agency BYOP capability bindings fail closed and must not silently consume hosted credits. Core WhatsApp Embedded Signup and separately purchased Unlimited calendars keep their preexisting product boundaries.
- F12-B does not implement a host registry or activate public brand-host request routing. Wire the verified hostname to this guard and test unknown/deactivated domains, forged Host headers, cookies and callback origins in F12-D/E/F. Never pass a raw user-provided purchaser ID as the approved host identity.

### F12-C — Purchaser-side brand management (canonical domain only)

**Goal:** Agency purchaser configures a branded product in AI Caller without changing their own canonical AI Caller control center.

**Implementation**

- Create `Whitelabel` section in canonical app with brand name, tagline, approved logo/icon/favicon uploads, palette, support email/link, preview, save draft and publish; reuse the existing UI design language and shared components.
- Schema-validate lengths/colors/URLs/media formats and limits; scan or decode permitted asset formats, re-encode raster uploads as appropriate, disallow executable SVG/HTML unless a secure sanitizer pipeline is explicitly justified, serve assets with correct content type/cache.
- No brand-specific secrets in client JSON; allow only public published brand fields in the client-facing resolver.
- Version and audit publication; revert safely to prior published brand; invalid logo/icon cannot break navigation/auth. Default branding is stable for incomplete accounts.
- Scope admin mutation by commercial purchaser. An Agency Admin may get narrowly delegated read/preview if approved, but buying, domain ownership and BYOP keys should not be implicitly delegated.

**Tests first:** Distinct purchasers, access control, invalid uploads/theme, draft vs published, concurrent edits/version conflict, fallback on deleted asset, mobile/desktop visual snapshots.

**Exit:** A purchaser can save, preview and publish one brand on canonical AI Caller; canonical purchaser dashboard remains AI Caller-branded; no widget change.

### F12-D — Verified custom domain, server-side Traefik routing and automatic TLS

**Goal:** A client-facing subdomain becomes HTTPS-active without an individual AI Caller deployment or always-running DeployOS desktop app.

**DNS/claim contract**

- MVP subdomain `app.customer.example`; normalize IDN to canonical punycode, lowercase, strip trailing dot, reject ports, URL paths, IP literals, internal/localhost suffixes, known canonical/reserved hosts and unsupported wildcard/apex scenarios.
- Display `A app → PUBLIC_VPS_IP` (real configured address), plus an account/domain-specific TXT proof for ownership claim, e.g. `_ai-caller-verify.app.customer.example → <one-time-token>`. Do not equate shared-IP A record with purchaser ownership. If existing AAAA record points away from VPS, display a specific remediation; check authoritative DNS and account for propagation/cache.
- Enforce globally unique hostname and atomic claim; reconfirm proof on transfer; store only hash of ownership secret where feasible; retry boundedly without spamming DNS/ACME providers.

**VPS infrastructure**

- Inspect current running Traefik configuration and provider ownership on the VPS. Add dedicated watched file-provider directory or compatible durable dynamic route provisioning without overwriting DeployOS-generated proxy configuration. Keep canonical web and separate voice-gateway router unchanged.
- A small *server-side* domain reconciler (bounded worker with narrow filesystem interface, or separate constrained helper) materializes only approved/verified hostnames; allowlisted template, atomic file replace, stable route/service IDs, no arbitrary config injection from user hostname. Web process should not need broad root/Docker socket permission.
- Configure persistent ACME storage and cert resolver; use HTTP-01 on public port 80 if supported by existing Traefik topology, HTTPS on 443, correct redirects and challenge handling; staging ACME first, production issuance only after checks.
- Registration states: DRAFT → AWAITING_DNS → VERIFIED → ROUTE_PROVISIONING → CERT_PENDING → CERT_READY → ACTIVE; failure states with error category; DISABLING/DISABLED/REVOKED. F12-D may reach CERT_READY with a deliberately limited setup/maintenance response; only F12-E/F integration may set ACTIVE after a public HTTPS fetch returns correct cert SAN, expected brand-host routing, auth allowlist synchronization, and functional client app/auth probe.
- ACME storage, domain config directory and audit survive web/worker/Traefik restart and application redeploy. Monitor renewal failures and alert with lead time; never log private keys/cert storage or proof tokens.
- Remove/deactivate only affected custom-host router on WL/prerequisite loss or domain disconnection; canonical app and unrelated brands remain healthy. Mark pending jobs/renewal behavior explicitly; do not leave a branded unentitled host with a login screen.

**Tests first:** Valid A+TXT; TXT missing/wrong/stale; hostname collision; IPv6 mismatch; domain no longer points at VPS; route file injection; job replay; ACME delayed/failed/renewed; browser invalid certificate; reactivation after fix; server and Traefik restart; two domains created concurrently; unrelated web/voice hostname unaffected.

**Exit:** One real test customer subdomain goes from DNS through ownership proof to CERT_READY with valid public HTTPS and provisional routing, persisting across redeploy **without DeployOS desktop running**; full client-domain ACTIVE is explicitly gated on F12-E and F12-F. Durable route and cert artifacts documented with sanitized evidence.

### F12-E — Better Auth multi-domain and branded invitation/authentication

**Goal:** Existing shared user database/auth system serves canonical purchaser domain and approved client domains with host-specific session cookies and correct links.

**Authoritative documentation to follow:** Better Auth Dynamic Base URL and v1.7 upgrade/reference options; inspect installed package version/types before implementing. Current `server/auth/index.ts` uses static `baseURL: env.BETTER_AUTH_URL`. Better Auth documents object-form `baseURL.allowedHosts`, `protocol`, optional `fallback`; matching hosts become trusted origins. It also documents proxy-header behavior and direct `auth.api` calls without host context. Never assume `trustedOrigins` alone makes unknown hostnames valid as base URLs.

**Implementation**

- Configure exact canonical + ACTIVE approved brand hosts as Better Auth allowed hosts; `protocol: 'https'` for production. No `*`, suffix wildcard for all customer domains, or request-host trust without exact registry match. Define one deterministic allowlist refresh mechanism: supported dynamic configuration after version-specific proof, or generate a signed/validated host snapshot and controlled web restart. Do not promise hot reload from a static constructor.
- Reject unknown/deactivated hosts at reverse proxy and application BEFORE auth fallback. For internal direct `auth.api` calls, supply explicit canonical request context where supported or a strictly bounded canonical fallback only after unknown-public-host rejection is proven. Preserve a single Better Auth secret and account database.
- Enforce host-only, secure, HTTP-only auth cookies; **disable cross-subdomain cookie sharing** for unrelated client-owned domains. Keep session/cookie namespace and CSRF/trusted-origin behavior consistent with Better Auth documentation.
- Resolve brand before rendering client-facing login/sign-up/reset/invite. Canonical page retains AI Caller. Client-origin password reset and verified invitation links remain on the same branded hostname; user-created `redirectTo` must be locally constrained and origin-checked. Shared user account does not imply a shared browser session between unrelated domains.
- In `server/auth/workspace-invitation-service.ts`, pick the domain from the *workspace's commercially owning active brand* for eligible client invites; otherwise use canonical origin. `server/email/mailer.ts` chooses permitted brand copy and link. Existing invitation token/email-match/revocation checks remain unchanged.
- Audit every static `BETTER_AUTH_URL` usage. OAuth/calendar callback URLs and Telnyx/Meta/provider webhooks should remain on deliberately configured stable canonical endpoints unless a provider-specific change is justified and verified; a custom client domain must not silently redirect carrier callbacks or provider auth registrations.

**Tests first:** Login/logout on each host, session not portable via cookies, exact approved host, forged `Host`/`X-Forwarded-Host`, proxy trust mode, missing header internal API, redirect injection, reset invite link consistency, revoked domain mid-session, domain switching, canonical purchaser login, worker/invite flows, asset/metadata no-cache cross-tenant.

**Exit:** Real HTTPS auth flow for the approved test host (initially using the baseline client shell), branded-domain invite/sign-in/reset and canonical purchaser sign-in work concurrently; unapproved host fails closed, not silently canonical-fallback-branded; no credential/session leakage. Final brand-complete portal activation is verified in F12-F.

### F12-F — Client-facing branded application and origin-aware UI

**Goal:** Clients feel they use the Agency purchaser's platform; purchaser retains AI Caller control center.

**Implementation**

- Central `BrandContext`/server resolver and shared brand header/logo/theme primitives; no hardcoded find-and-replace across pages; make `app/layout.tsx` metadata host-appropriate without caching one brand globally.
- Brand: client login/signup/reset, navigation/header, browser title/favicon, dashboard and permitted business pages, Agency-approved client-facing reports, support destination and supported client invitation/auth emails. Logo and business identity remain distinct: product brand = Stratos Assist; workspace business = Sheridan Cleaning.
- Custom host allows only the client portal route/API set. Deny purchaser commerce/Agency credit pool, Agency Workspaces inventory, template admin, Whitelabel settings and provider credential administration, including direct URL/API attempts. Retain appropriate client-specific workspace billing read access and client checkout restriction.
- Existing Agency purchaser client-management workflow on canonical app remains intact. Invites on active brand origin; preserve canonical safe fallback communications for suspended domains with explicit UX.
- Protect visual regression at desktop/mobile and accessibility contrast/focus; no widget branding or embed migration.

**Tests first:** 2 brands × 2 clients, logo/color/favicon/title, owner/staff navigation, no sibling workspace, purchaser main domain unchanged, client URLs for invites/reset, restricted API access, content cache/SSR brand isolation, mobile snapshots.

**Exit:** Client A and B log in on purchaser's custom host, see same purchaser brand with their own isolated business data; purchaser can administer both via main AI Caller.

### F12-G — One purchaser-wide provider infrastructure mode and transactional transitions

**Goal:** Remove mixed hosted/BYOP configurations from the Whitelabel client estate and make ownership of provider costs unambiguous.

**Implementation**

- Persist one purchaser-level `HOSTED | BYOP` active mode, transition version and audit. Default existing Agency purchaser to HOSTED; do not rewrite legacy provider credentials or routes in-place during migration.
- Define controlled bundle as the supported AI text, voice and SMS provider infrastructure. Validate existing Core WhatsApp/Meta connection separately as explained in §1.3; calendar retains its independent entitlement; neither exception permits mixing the controlled bundle.
- In HOSTED: prohibit client/direct-API BYOP bind/connect/dispatch for controlled capability, resolve hosted only, enforce wallet/hosted usage rules.
- In BYOP: prohibit hosted controlled dispatch/hosted credit debit; purchaser-only provider setup and readiness; all affected commercially owned workspaces resolve BYOP using purchaser-managed profile and per-client sender identity where required.
- Stage mode switch; verify all required provider connections, per-client channel readiness and number/webhook/signature ownership, consent, campaign readiness and in-flight job handling. Switch authoritative mode/version atomically with a clear effective time; workers use versioned operation context and cannot combine old/new routes halfway through a job. A controlled rollout must not leave a window in which some purchaser-owned businesses dispatch hosted while others dispatch BYOP.
- If staging fails, retain old mode, show failing prerequisites and make zero provider route changes. Prevent silent fallback on missing secret, refund or provider error. Save previous profile for explicit rollback after new readiness checks.
- The original purchaser's commercially owned PRIMARY business also participates in the same mode, even though its account-management UI stays on the canonical AI Caller hostname; preexisting hosted/BYOP settings must be staged and migrated deliberately rather than rewritten invisibly. Mere operational membership in another purchaser's workspace does not bring that workspace into this mode.

**Tests first:** No mix by capability or client; 50/100/150 client capacity; direct API bypass; host-injected client selection; switch with queued SMS and active call; zero credit, missing VOICE binding, provider outage, WL/Agency revocation, stale worker job, concurrent mode switch; idempotent resume/rollback.

**Exit:** One authoritative mode and consistent routing/cost evidence for the original purchaser business and all purchaser-owned businesses; no accidental hosted credit spending when BYOP is selected.

### F12-H — Hosted mode: reuse Agency pool and existing managed channels

**Goal:** Whitelabel HOSTED works with the already-built Agency product, not a new billing engine.

**Implementation**

- Reuse Stripe purchaser-only Agency pool top-up and auditable wallet allocation; client workspace wallets remain isolated; delegated client owner may see own balance/history but cannot buy our credits or withdraw Agency pool funds.
- Validate new Agency cloned client readiness (client business/agent, phone, carrier approval for outbound SMS, wallet, booking prerequisites) before activating copied agent, reusing D4 rather than bypassing it.
- Reuse managed Telnyx single-number allocation per client; hosted provider keys remain platform secrets. Do not clone sender identities/consent/number when copying an Agency template.
- Preserve credit reservations, debit/reversal, phone recurring charge, low-credit limits and invoice reconciliation. Platform provider cost versus customer credit rate is not solved merely by credit balance tests.

**Tests first:** Pool purchase replay and dispute, allocation replay/concurrency, client checkout denial, wallet isolation, insufficient credits, credit debits exactly once, approval not present → SMS suppressed, activation blocked until client readiness, cross-client usage isolation.

**Exit:** Realistic staged Agency + WL HOSTED E2E, no new credit model or per-client automatic free grants; existing #24/#31 live acceptance explicitly still required.

### F12-I — BYOP purchaser-managed provider profile and per-client provisioning

**Goal:** Agency connects its own eligible accounts once, then configures each client identity without duplicating sensitive credentials or giving clients provider-admin power.

**Implementation**

- Reuse credential encryption, provider adapters, test connection, usage/activity and webhook signature checks. Add purchaser-scoped secret/profile ownership or an equivalently reviewed ACL layer; client binding references an authorized profile, not a cloned API key. Credentials are never serialized into Agency templates, logs, reports, preview, API responses or invitation email.
- Supported initial adapters **from current repository**: AI OpenAI/Gemini/OpenRouter; voice Telnyx; SMS Telnyx/Twilio/Plivo. Test actual capabilities independently (an SMS adapter does not grant voice). Predefined provider endpoint and credential schema only; do not accept arbitrary provider URL as an SSRF primitive.
- Define per-client phone/sender assignments, unique webhook routing, signature/public-key validation and transport readiness. Reuse one-number-per-workspace policy for supported voice/SMS service; do not implement new multi-number purchasing. A purchaser API key can cover multiple provider identities only if the provider and our runtime actually support it.
- Purchaser can configure/change credentials and client sender mappings from canonical account; clients may view their connected status if suitable but not receive master keys or choose mixed mode. Validate exact Agency commercial owner, not merely workspace OWNER membership.
- Preserve recipient consent and purpose checks, carrier approval and delivery receipts; a connected BYOP Telnyx/Twilio/Plivo account does not establish an approved 10DLC campaign. Whitelabel does not reopen concluded Phase 6C SMS runtime changes except specifically authorized regression fixes.
- Version credential/route references to handle in-flight operations. On disconnected/revoked/expired credential, block and surface actionable error; never use AI Caller-hosted key invisibly.
- Define transparent usage ledger: record provider mode and provider operation IDs; no hosted provider-consumption credits are charged for BYOP, but separately disclosed platform charges (if any) require their own explicit contract and tests. Do not manufacture a BYOP credit resale program.

**Tests first:** Secret ACL, masked GET, cross-purchaser profile binding, cross-client phone collision, callback spoof/replay, denied client credential edit, provider-specific test fail, case of lost callback, missing approval, BYOP credit non-debit, error route remains BYOP blocked, encrypted key rotation, Agency or WL revocation.

**Exit:** A purchaser's authorized BYOP test client completes at least one supported AI interaction, actual Telnyx voice path and approved SMS path when suitable accounts exist; untested adapters remain explicitly unverified. No cross-client provider identity or billing leakage.

### F12-J — Revocation, recovery, migration and operations

**Goal:** Keep client data and original Agency business available during domain/provider/license failures without unauthorized service or unplanned billing.

**Implementation**

- Effective WL state separately records purchaser's paid Whitelabel license, Agency prerequisite, domain state and provider-mode readiness. Domain SSL failure is not equivalent to refund; provider outage is not license revocation.
- On WL loss: stop custom hostname serving authenticated client portal and new WL-only BYOP operations; do not delete clients, phones, credits, appointments, conversations, agency templates, domain proof or encrypted credentials; issue purchaser-visible remediation. Existing Core/Agency rights remain as permitted, via canonical origin, subject to intentional client-access transition.
- On Agency loss with WL receipt active: WL becomes ineffective; existing client workspaces remain intact and cannot be expanded; restore eligibility when a valid Agency receipt returns, then recheck domain and BYOP readiness before service resumes.
- On domain DNS drift/renewal failure: do not mark domain active or serve wrong brand; alert purchaser, preserve original AI Caller admin and unrelated domains. Provide controlled disable/re-enable and domain release/transfer with fresh ownership proof.
- On BYOP failure: status BLOCKED/PARTIAL_READINESS as appropriate and intentional operator retry, not hosted fallback. Keep message/booking side effects idempotent, and do not invalidate historic receipts.
- Backfill preexisting Agency purchasers with HOSTED mode safely, with migration report and no blanket rewrite of connected integration bindings. Detect existing Agency BYOP configurations from earlier code and explicitly flag for controlled reconciliation rather than silently turning them into valid WL BYOP.
- Persist minimal audit and operational metrics (activation duration, TLS last success, domain unresolved, auth host rejects, provider binding failure, mode-switch success, credits by mode); redact email/phones/keys in broad metrics.

**Tests first:** Refund and duplicate revoke; two Agency receipts; domain expiration; storage loss and backup restore; failed mode stage; mid-call revocation; queued SMS; degraded provider; two purchases racing; historical clients and wallets unchanged.

**Exit:** Recovery playbook and dry-run proof for license, domain, login and provider incidents; zero destructive implicit migrations.

### F12-K — Integrated end-to-end acceptance and release gate

**Goal:** Demonstrate the product customers will buy, not merely successful isolated tests.

**Test personas:** P1 Agency+Whitelabel HOSTED; P2 Agency+Whitelabel BYOP; C1 and C2 delegated client OWNER; client STAFF; an unrelated Agency purchaser P3; purchaser with WL receipt but no Agency; purchaser with Agency but no WL.

**Minimum scenarios**

1. Agency-only account has no Whitelabel brand/domain/BYOP entitlement; Whitelabel purchased without Agency never activates.
2. Agency+WL purchaser stays on AI Caller canonical domain and creates/brands one customer domain; 2 clients access it with their own roles and isolated content.
3. Exact hostname mapping; forged host/proxy headers and wrong active-workspace cookie rejected; invalid wildcard and second claimant fail.
4. A+TXT verification; actual HTTPS cert SAN and redirect; ACME renew/redeploy persistence; separate canonical app/voice gateway remain healthy.
5. Client invite, signup, login, logout, forgotten password, session expiry, revocation and cross-host cookie behavior on real public hostname.
6. Hosted purchaser top-ups Agency pool and allocates client credits; client cannot self-checkout; usage takes exactly one expected credit debit, approvals respected.
7. BYOP purchaser passes supported provider readiness and uses their own credentials/identities; no hosted provider debit. Missing/expired provider blocks rather than silently shifting modes.
8. Attempted mixed-mode configuration at provider and client levels fails through browser and direct APIs. Switching mode with in-flight operations is audited and deterministic.
9. Purchase event replay, refund, chargeback, Agency expiry, WL restoration and over-cap client count preserve unrelated licenses, wallets, workspaces, and data.
10. Existing standard booking, Phase 6C SMS, WhatsApp, voice, Agency delegated access/cloning, dashboard and Performance gating are not regressed. Live provider proofs are recorded individually.

**Mandatory evidence:** Reviewed changed-file list, SHA, migrations, full tests, typecheck, production build, Biome/lint if present, browser screenshots desktop/mobile, proxy config before/after, public DNS observations, cert dates and hostname SAN, sanitized auth/invite traces, provider transaction IDs, credit ledger comparison, rollback probe, main post-merge CI, list of skipped live provider gates.

**Exit:** All critical/required findings resolved, exact-head green CI and post-merge main CI; real HTTPS branded login on production-like DeployOS/VPS; hosted credits E2E; BYOP provider acceptance for specifically supported/available adapters; founder's owner acceptance. If a live carrier registration is blocked, do not label that carrier path live-ready merely because Whitelabel pages work.

---

## 5. Cross-cutting tests and failure matrix

| Failure / misuse | Required result | Primary verification |
|---|---|---|
| WL receipt purchased but no active Agency | Preserve receipt and prompt Agency prerequisite; no WL route/brand/BYOP activation | F12-A |
| Two operational OWNER memberships | Commercial purchaser resolved correctly; no entitlement disappearance or client privilege escalation | F12-B |
| Client opens `/api/agency/credits` on branded host | 403 or intentionally concealed 404; no data disclosed | F12-B/F |
| Client forges sibling workspace ID | Denied regardless of membership cookie/client-side routing | F12-B/F |
| Another purchaser claims same hostname | Atomic unique conflict; original verified claim preserved | F12-D |
| A points to same shared IP, TXT absent | Do not treat A as purchaser ownership proof | F12-D |
| Stale AAAA / wrong DNS / Cloudflare proxy mismatch | Actionable DNS state; no false ACTIVE | F12-D |
| ACME rate limit, challenge timeout or loss of persistent storage | No false ACTIVE; alert, preserve canonical app, bounded retry/staging | F12-D/J |
| Unknown custom `Host` or spoofed forwarding header | Fail closed; do not choose fallback brand or reveal canonical auth data | F12-E |
| Client password reset originates on branded host | Correct approved branded URL; safe redirect; no token in logs | F12-E |
| Agency purchaser still uses canonical account | AI Caller brand, original purchases and Agency operations intact | F12-C/F |
| Branded host shows purchaser billing/admin | Blocked even if URL guessed | F12-B/F |
| Attempt hosted AI with BYOP SMS | Reject as mixed infrastructure; no partial activation | F12-G |
| BYOP license lost / API key invalid | Explicitly blocked; no hosted-credit debit or silent route replacement | F12-G/I/J |
| Whitelabel/Agency refund while client has bookings | No data deletion; defined access handling and action idempotency | F12-A/J |
| Mode switch while queued SMS/call active | Versioned route and deterministic operation completion, no duplicates or mixed charging | F12-G/I |
| BYOP client tries to edit purchaser credentials | Denied; no key disclosure | F12-I |
| Hosted Agency top-up replay | Pool balance/allocations remain idempotent | F12-H |
| Different host's cached brand returned | Cache keyed by approved host/brand version; no cross-tenant appearance | F12-C/E/F |
| Existing SMS Phase 6C fixture fails after entitlement change | Repair only new feature or generic test setup; do not change frozen SMS semantics | All milestones |

### Review checklist on every PR

1. **Correctness:** matches this contract, explicit error paths, concurrency/idempotency, persisted state under retries.
2. **Readability:** minimal code paths, descriptive names, no dead shims or obsolete `agencyByop` branch after migration.
3. **Architecture:** existing workspace/commercial owner, Better Auth, provider adapters, wallets, existing Agency UI patterns; no second auth/database/billing engine.
4. **Security:** exact-host validation, proxy trust, session and origin checks, tenant isolation, encrypted secrets, capability/server authorization, webhook signature and consent checks.
5. **Performance:** bounded DNS/reconciler retries, avoid N+1 brand/entitlement DB reads on each render/route, cache keyed by verified host and entitlement revision with safe invalidation, bounded Agency client inventory/pagination.
6. **Verification:** distinguish locally inspected code vs CI vs live deployed SHA; do not call a test/build green without the actual run and exact commit evidence.

Keep focused PRs, preferably ~100–300 changed lines per logical slice when practical; large framework integration is acceptable only when split would create unsafe intermediate states and the diff remains independently reviewable. Changes to an accepted milestone require the regression suite for all dependent milestones.

---

## 6. Runbook: diagnose by layer rather than random fixes

### 6.1 “Custom domain does not work”

1. Is the domain claimed by the correct purchaser? Check normalized hostname + owner + WL/Agency effective status without revealing challenge token.
2. Is the TXT proof present and current? If not, show DNS help; do not add routing.
3. Is A pointing at the current VPS IP? Is an unexpected AAAA or CDN/proxy altering the path? Compare authoritative answers and DNS cache.
4. Is generated Traefik router present and loaded from *persistent* watched config? Inspect sanitized route name, Host rule, service target, and Traefik diagnostic logs. Do not edit ephemeral generated config.
5. Does HTTP challenge reach Traefik port 80? Is certificate storage persistent/writable? Inspect ACME category and CA rate-limit/staging settings, never private key.
6. Does public HTTPS present a certificate valid for this exact hostname? Verify `SAN`, TLS health and renewal expiry; an HTTP 200 with a default certificate is not ACTIVE.
7. Does the application hostname resolver find the **same** brand and is Better Auth allowlist synchronized? Confirm host-specific sign-in/reset while canonical app and voice gateway remain healthy.
8. Record tested running SHA, time, DNS answer, route revision and sanitized log reference before closing.

### 6.2 “Branded client is seeing the wrong account or cannot log in”

1. Verify exact incoming hostname/proxy-header interpretation and brand mapping.
2. Verify Better Auth's approved host and trusted origin, secure host-only cookies and actual public protocol.
3. Verify user account/session and invited email; check invitation link's brand-host resolution and token status.
4. Verify requested workspace commercial owner equals brand purchaser; then membership, operational role, seat restrictions and workspace status.
5. Inspect active-workspace cookie and cache key: a stale foreign workspace ID must fail/choose only permitted local workspaces, never fall back to a sibling purchaser's business.
6. Validate login/reset success for two users on two brand hosts and canonical purchaser account before approving repair.

### 6.3 “BYOP stopped or credits were charged incorrectly”

1. Read active purchaser mode/version, effective Core+Agency+WL, and operation's captured route revision.
2. Verify client workspace belongs commercially to purchaser and was included in an authorized provider profile.
3. Check selected provider capability, encrypted credential test time, per-client phone/sender identity, relevant carrier approval, webhook signature and permitted consent.
4. Check queue/send/voice operation IDs and provider receipts for ambiguous acceptance; do not retry blindly.
5. Compare AI Caller credit ledger and provider invoices/usages: HOSTED consumes documented credits, BYOP must not charge hosted provider consumption. Keep separately agreed platform fees explicit.
6. If mode was switched recently, check staged prerequisites, audited effective time and old in-flight operation handling; fix stale routing at the central policy layer, not by silently enabling HOSTED fallback.

### 6.4 “Refund left clients unable to access branded app”

Inspect WHITELABEL receipt status, active Agency receipts, Core and effective entitlement separately; confirm branded router status, client data persistence, canonical purchaser login and agreed temporary client access/communication path. Never delete an Agency-owned client workspace or credit wallet to clear an inactive brand. Reinstatement requires validated receipts plus DNS/TLS/provider readiness checks.

---

## 7. Deferred work and explicitly excluded features

- Website widget rebranding, changing widget embed origin/loader design or breaking legacy embeds.
- Stand-alone Core+Whitelabel offer; Whitelabel without Agency client capacity.
- Per-client brand and per-client custom domain; multiple brands per purchaser; marketplace of white-label sub-resellers; arbitrary delegated commercial owners.
- Per-capability hosted/BYOP mix, per-client mode override, automatic BYOP→HOSTED provider-cost fallback.
- New provider adapter without independent acceptance; Telnyx compliance approval inferred from key connectivity.
- Multi-number purchase, multi-agent workspaces, hosted AI/voice/SMS replacement, separate client databases/containers, arbitrary domains running untrusted tenant code.
- Whitelabel grant of Unlimited imported knowledge/external calendars or Performance Builder to client workspaces.
- Custom outbound-email infrastructure/SMTP domain reputation and sender-domain verification unless a separate, scoped milestone is approved. F12 may brand permissible email body/from display names using the already configured mailer; do not claim a purchaser-domain `From` address works without DNS and provider authorization.
- Automatic resale payment collection from clients, payment split, independent Agency invoicing or additional white-label tiers. Purchaser continues commercial management in AI Caller.

---

## 8. Follow-up ledger and signoff rules

For each milestone record:

| Field | Required entry |
|---|---|
| ID / PR | F12-X, numbered PR and purpose-specific imperative title |
| Source SHA | Base `main`, PR exact final head, merge commit, post-merge `main` head |
| Scope | User-visible behavior, schema/API changes, explicit exclusions |
| Tests first | Test names/scenarios that would fail before implementation |
| Checks | Migrations, tests, typecheck, build, relevant browser suites, live proof if needed |
| Review | Critical/required/nit findings and resolutions |
| Evidence | Sanitized logs, fixture screenshots, live hostname/cert/route/provider IDs, no secrets |
| Rollback | Feature/route flag and state-safe rollback, preserved data |
| Remaining | Explicit unsupported/later/provider-blocked items; named issue with owner |
| Verdict | **Approve — Ready to merge** or **Request changes — Issues must be addressed** |

Do not close F12 on simulated DNS responses, fixture-provider success or an idle green CI run. An authoritative F12 close requires complete coding plus live domain and authentication proof, a working hosted Agency path, verified intended BYOP paths, and precise disclosure of external carrier/provider approval still pending. F13 (entire funnel release) remains a separate subsequent commercial acceptance milestone.

---

## 9. Source references for future implementers

**Internal (read `main` at implementation time; this document describes the inspected 25 September 2026 baseline):**

- `docs/assistlia-funnel-implementation-plan.md`
- `docs/phase-6c-sms-automation-readiness.md`
- `docs/deployos-realtime-gateway.md`
- `server/commerce/products.ts`; `server/commerce/agency-lifecycle.ts`; `server/commerce/account-licenses.ts`; `server/commerce/workspace-entitlements.ts`
- `db/schema/core.ts` (`workspaceCommercialOwners`, `licenses`, `memberships`); `db/schema/integrations.ts`
- `server/agency/credit-pool.ts`; `server/agency/access.ts`; `server/agency/template-readiness.ts`
- `server/providers/catalog.ts`; `server/providers/resolver.ts`; `server/providers/ai.ts`; `server/providers/voice/runtime.ts`; `server/providers/sms/runtime.ts`
- `server/domain/integrations/repository.ts`; `app/api/integrations/**`
- `server/auth/index.ts`; `server/auth/workspace-context.ts`; `server/auth/workspace-invitation-service.ts`; `server/email/mailer.ts`; `lib/auth-client.ts`
- `app/layout.tsx`; `components/core-domain/app-nav.tsx`; `docker-compose.yml`; related deployment docs.
- Open issues [#24](https://github.com/videoxq-dev/AI-Caller/issues/24), [#28](https://github.com/videoxq-dev/AI-Caller/issues/28), [#31](https://github.com/videoxq-dev/AI-Caller/issues/31), [#44](https://github.com/videoxq-dev/AI-Caller/issues/44), [#48](https://github.com/videoxq-dev/AI-Caller/issues/48), [#57](https://github.com/videoxq-dev/AI-Caller/issues/57).

**External documentation reviewed (implementation must reconfirm against installed versions and live VPS):**

- Better Auth Dynamic Base URL: https://better-auth.com/docs/guides/dynamic-base-url
- Better Auth v1.7 upgrade: https://better-auth.com/docs/guides/1-7-upgrade-guide
- Better Auth baseURL/options: https://better-auth.com/docs/reference/options
- Traefik ACME: https://doc.traefik.io/traefik/master/reference/install-configuration/tls/certificate-resolvers/acme/
- Traefik file provider: https://doc.traefik.io/traefik/reference/install-configuration/providers/others/file/

**Decision log:** 2026-09-25 founder clarified Agency is required to make Whitelabel commercially meaningful; purchaser stays on canonical AI Caller domain; custom domain serves clients; purchaser selects **exclusive hosted or BYOP**, not mixed; AI Caller operates platform infrastructure in both modes; SSL automated on VPS; widget branding excluded.
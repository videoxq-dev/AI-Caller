# Phase 6A — WhatsApp Template Management Inventory and Scope

**Baseline:** main at `e455d058964113b16150a95b4df9b17f17f23c04`, after Phase 4 merge. Phase 5 is deferred.

## Confirmed existing implementation

| Contract | Verified implementation | Notes |
|---|---|---|
| Meta account linking | `server/providers/meta.ts` and `app/api/integrations/meta/complete/route.ts` | Embedded Signup exchanges the code, retrieves the WABA and phone-number identity, optionally registers the phone, and subscribes the app. Credentials are stored encrypted per workspace. |
| WhatsApp routing | `server/providers/whatsapp/runtime.ts` | Connected BYOP WhatsApp binding resolves the workspace's WABA, phone-number ID and decrypted token server-side. |
| Inbound and receipts | `server/providers/whatsapp/meta-cloud.ts`, `server/whatsapp/service.ts` | Signed WhatsApp message and delivery webhooks are normalized, deduplicated and attributed to the configured phone number. Non-message WABA template status notifications were previously ignored. |
| Outbound | `server/whatsapp/outbound.ts`, `server/providers/whatsapp/meta-cloud.ts` | Freeform text enforces the 24-hour service window; a low-level template-send method already exists, but this is **not** evidence of template approval, proactive-send eligibility or end-to-end provider delivery. |
| Automations | `server/automations/builder-catalog.ts`, `server/automations/workflow-action-executor.ts` | No owner-configured WhatsApp template action in Phase 4; adding sending/consent/scheduling rules belongs to Phase 6B–6D. |
| Owner experience | `app/integrations/page.tsx` | Before Phase 6A: account linking and connectivity only, no template catalog, creation, submission or approval status UI. |

## Phase 6A implementation

- A dedicated **WhatsApp → Message templates** surface is linked from a connected WhatsApp integration.
- The list reads the workspace's connected WABA via Meta's `GET /{waba-id}/message_templates` and displays Meta's actual language, category, status, body/footer and available rejection reason. The first 50 templates are fetched; subsequent pages require explicit **Load more**. Refresh obtains up-to-date approval status; the list is not a local approval flag.
- The owner/admin can submit a **text-only** Utility or Marketing template using `POST /{waba-id}/message_templates`, with name, language, body, optional footer, and numbered placeholder examples. The provider response retains Meta's actual status, ordinarily PENDING; submission does not grant approval.
- WABA ID and credentials never come from client input. Every API request resolves the authenticated active workspace's connected integration and checks `integration.manage`. Graph origin is fixed and pagination reconstructs the URL from a bounded cursor; it does not follow returned `paging.next`.
- Meta remains the authoritative template catalog. No new database table, webhook subscription, background poller, or outbound action is introduced solely to duplicate Meta's status. Refresh the page to see Meta review decisions. This avoids drifting local approvals or a migration for data Meta owns.

## Explicit limits and live acceptance gate

- Phase 6A's creation form covers BODY text, optional FOOTER and positional examples. It does **not** support media/header/button/flow/authentication templates, template edits or deletion. Existing richer templates are visible in the catalog; do not silently mutate them.
- Template statuses are obtained via Meta API reads, not yet persisted from `message_template_status_update` webhooks. Real-time push notifications are outside this slice; refresh exposes actual status.
- **6B–6D must separately enforce actual approved template status, current sender binding, marketing consent/preferences, opt-outs, human takeover and outbound retry safety immediately before sending.** Do not use the Phase 6A submission response as a send authorization.
- Live acceptance requires a connected WABA with `whatsapp_business_management` permission (and any applicable Meta Tech Provider/App Review access), successful real submission, and a later read showing the provider's decision. No CI fixture proves Meta approved a customer's template.
- One managed Telnyx number per workspace remains unchanged. WhatsApp Embedded Signup has its own WABA/phone assets; the Telnyx SMS 10DLC administrative gate remains separate.

Provider reference: Meta's public WhatsApp Cloud API Postman collection, `/{WABA-ID}/message_templates` GET/POST and Embedded Signup documentation (https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api and https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup).

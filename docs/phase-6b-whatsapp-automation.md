# Phase 6B — Approved WhatsApp Template Automation

Based on merged SMS enforcement PR #55 and the existing Phase 6A Meta template catalog, Phase 3 durable workflow ledger, and earlier predefined WhatsApp appointment automations.

## Delivered code contracts

- Owner-facing structured Builder offers `SEND_CUSTOMER_WHATSAPP` using the connected business's **Meta-approved, text-only** Utility or Marketing templates. Lists use the authenticated workspace's WABA; pages are bounded at 50 and loaded explicitly. Template placeholders are mapped to registered event variables (no scripts or arbitrary field paths). Dry runs cannot send.
- Publishing resolves the **exact** template name/language from Meta, validates the body placeholders against the selected event variables, and freezes the approved category with the immutable workflow version. Runtime checks category and current approved template body again before dispatch; an edited, paused, rejected, missing, or cross-account template cannot silently inherit approval.
- Existing WhatsApp outbound service is the only sender. Both predefined appointment template sends and new custom actions use this service. It validates current approval, recipient's WhatsApp-specific Utility/Marketing permission, and populated body placeholders. A separate SMS opt-in never authorizes WhatsApp marketing. New custom actions retain existing action-scoped delivery identity, ordering, duplicate-claim recovery, appointment-revision freshness and Activity visibility. Definite policy blocks are SKIPPED; ambiguous carrier outcomes stay UNKNOWN and are never blindly replayed.
- Signed inbound WhatsApp STOP opt-outs update Utility **and** Marketing in one database transaction; START re-enables Utility only. The command message is recorded but not fed to booking/AI. Consent status has a current-state destination index and append-only evidence; authorized staff can record evidence on a contact's actual WhatsApp identity via the Contact drawer.
- Within the existing 24-hour service window, legitimate inbound customer-service replies continue without recurring opt-in unless expressly opted out; high-confidence promotional freeform text requires separate Marketing permission. All outbound WhatsApp messages recheck applicable opt-out state immediately before provider dispatch.

## Deliberate limitations

- Phase 6B's custom Builder uses BODY-text positional placeholders and text-only templates (BODY and optional FOOTER). Meta rich templates remain viewable in Template Management but require a separate component-aware editor; do not attempt to send unsupported headers/buttons with empty parameters.
- WhatsApp uses the connected Meta WABA and phone-number identity, not another managed Telnyx number. There is no new provider, sender, repeated unknown-outcome delivery or mode selector.
- In-code Meta lookup and CI fixtures are **not** proof that a real business WABA has the required permissions, real approved templates, consented recipient, or actual delivery. Live Meta acceptance must verify template submission/approval, category and language, the exact connected phone-number ID, a real send and signed delivery receipt, STOP suppression, credit/usage reconciliation (WhatsApp BYOP charge is zero app credits), and staff/automation acceptance on the deployed SHA.
- Template-status push webhook subscriptions, media/header/button/flow template authoring, WhatsApp message-quality analytics and the deferred Phase 5 are not silently delivered by this phase.

## Verification

The GitHub PR and exact-head CI status are authoritative; record the final SHA and CI run in PR #56 once complete. Relevant focused suites: `server/providers/whatsapp/meta-templates.test.ts`, `server/whatsapp/consent.test.ts`, `server/whatsapp/outbound.test.ts`, `server/whatsapp/service.test.ts`, and `server/automations/workflow-actions.test.ts`. Phase 4 browser acceptance additionally exercises the text-template editor on desktop/mobile and retains screenshots. The Meta integration route and live provider checks remain independently gated.

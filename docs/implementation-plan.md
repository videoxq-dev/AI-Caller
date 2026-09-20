> **September 20, 2026 remediation scope override:** [Intelligent Automation Phase 0 contract](./intelligent-automation-remediation-phase-0.md) governs the new remediation increment wherever older MVP/OTO roadmap language conflicts. Keep **one AI agent and one managed Telnyx phone number per workspace**; ordinary conversations work from the agent's default configuration without a workflow. Add optional situational conversational workflows and editable deterministic workflows through **one structured, non-drag-and-drop Automation Builder**, with execution mode derived by registered actions rather than chosen by the user. The old five-presets-only/no-builder statements below describe the historical MVP, not the approved remediation scope. Existing SMS carrier and deployment acceptance gates still apply.

# AI Caller — Backend & Full-Stack Implementation Plan

This document is the engineering roadmap for turning the completed UI into the working MVP defined in `docs/PRD.md`.

The product promise remains intentionally narrow:

> One AI-powered hub that answers inbound customer inquiries across phone, SMS, WhatsApp and web chat, qualifies the lead, books an appointment, updates the contact record, and hands the conversation to a human when necessary.

The most important implementation rule is the same rule in the PRD: **do not turn this into a general CRM, PBX, workflow builder, or GoHighLevel clone.**

---

## 1. Product boundaries

### MVP must do

- One workspace/business for the FE/Core plan.
- Email/password authentication and password reset.
- Guided onboarding persisted to the database.
- Starter hosted credits.
- BYOP/BYOK provider connections.
- Unified contact timeline across SMS, WhatsApp, web chat, and inbound phone transcripts.
- One AI agent per business.
- Business knowledge, services, FAQs, policies, hours, and escalation rules.
- Inbound AI phone answering only.
- SMS conversations.
- WhatsApp Cloud API conversations.
- Website chat widget.
- Calendar availability, booking, rescheduling, and cancellation.
- Contacts + lightweight leads.
- Human takeover / return to AI.
- Five predefined automations.
- Usage and credits.
- Outcome-focused dashboard.

### Explicit non-goals

Do not implement in the MVP:

- outbound AI calling
- full CRM pipelines
- email marketing
- funnels / landing pages
- invoicing
- advanced PBX / IVR / queues / extensions
- visual automation builder
- custom reporting builder
- sophisticated vector/RAG admin
- old-lead reactivation
- agency workspaces
- white labeling
- SaaS reseller provisioning

The data model may leave clean extension points for later OTOs, but we do not build those features now.

---

## 2. Architecture: modular monolith first

We should **not** start with microservices.

Use the existing Next.js application as the primary web/API application and add only the background processes that are genuinely required.

```text
Browser / Widget / Provider Webhooks
                |
                v
        Next.js Web + API
                |
      -----------------------
      |          |          |
      v          v          v
 PostgreSQL   Job Queue   Provider Adapters
      |          |          |
      |          v          |
      |       Worker        |
      |                     |
      -----------------------
                |
                v
         External Providers
```

Later, inbound streaming voice gets one dedicated long-lived process:

```text
Telephony media stream
        |
        v
   Voice Gateway
        |
        v
  Orchestrator / DB
```

### Recommended core stack

- **Language:** TypeScript everywhere.
- **Frontend/API:** existing Next.js 16 + React 19 application.
- **Database:** PostgreSQL.
- **ORM:** Drizzle ORM.
- **Validation:** Zod at every API/provider boundary.
- **Authentication:** Better Auth with database-backed sessions and email/password flows.
- **Background jobs:** pg-boss using the same PostgreSQL database; no Redis required initially.
- **Object storage:** S3-compatible storage for uploaded documents; Cloudflare R2 or equivalent.
- **Logging:** structured server logs with Pino.
- **Unit/integration tests:** Vitest.
- **Browser tests:** Playwright.
- **Package manager:** keep npm unless there is a concrete reason to change.

### Deployment shape

For the MVP, prefer a normal long-running Node deployment rather than relying entirely on serverless functions because inbound voice eventually requires WebSockets/media streaming.

Recommended deployment units from the same repository:

1. `web` — Next.js application + REST endpoints + webhooks.
2. `worker` — pg-boss consumer for automations, reminders, extraction jobs, and retries.
3. `voice-gateway` — added only when voice implementation begins.

A single managed PostgreSQL database is shared by the web and worker processes.

---

## 3. Repository structure

Do not turn the project into a large monorepo yet. Keep the current Next.js structure and add server/domain folders.

```text
app/
  api/
    auth/
    business/
    agent/
    contacts/
    conversations/
    appointments/
    automations/
    integrations/
    usage/
    dashboard/
    webhooks/
    widget/

components/

db/
  schema/
  migrations/
  index.ts

server/
  auth/
  domain/
  orchestrator/
  providers/
    ai/
    sms/
    voice/
    whatsapp/
    calendar/
  knowledge/
  credits/
  automations/
  jobs/
  security/
  observability/

worker/
  index.ts

voice/
  gateway.ts          # add only when voice work starts

lib/
  api-client/
  validation/
  shared-types/

docs/
```

Rule: UI components should never directly know provider-specific credentials or SDKs. Provider code belongs under `server/providers`.

---

## 4. Multi-tenant model

Even though FE/Core supports only one business, every domain record must belong to a workspace from day one. This prevents a painful rewrite when Agency is added later.

### Core ownership chain

```text
User
  |
Membership
  |
Workspace
  |
Business Profile
```

For the MVP:

- a normal FE customer receives one workspace;
- a workspace has one business profile;
- every contact, conversation, appointment, agent, integration, automation and usage event has `workspace_id`;
- every API query must scope by `workspace_id` derived from the authenticated session, never from untrusted client input alone.

---

## 5. Database model

The following is the minimum practical schema. Avoid adding tables for speculative features.

### Identity and access

#### `users`

- `id`
- `name`
- `email`
- auth-library fields
- `created_at`
- `updated_at`

#### `workspaces`

- `id`
- `name`
- `status` — `ACTIVE | SUSPENDED`
- `created_at`

#### `memberships`

- `workspace_id`
- `user_id`
- `role` — `OWNER | ADMIN | STAFF`

#### `licenses`

Used for JVZoo/core/OTO entitlement tracking.

- `id`
- `workspace_id`
- `source` — `JVZOO | MANUAL`
- `external_purchase_id`
- `product_code`
- `status`
- `purchased_at`
- `raw_metadata` JSONB

#### `workspace_entitlements`

Keep entitlements simple and explicit.

- `workspace_id`
- `key`
- `value` JSONB

Examples:

- `workspace_limit = 1`
- `calendar_connection_limit = 1`
- `knowledge_limit = ...`
- `multiple_agents = false`
- `visual_automation_builder = false`

Do not implement OTO features yet. Only enforce limits required by the FE/Core product.

### Business and AI configuration

#### `business_profiles`

- `workspace_id`
- `business_name`
- `industry`
- `website_url`
- `phone`
- `address`
- `city`
- `state`
- `postal_code`
- `country`
- `service_radius`
- `timezone`
- `summary`
- `setup_completed_at`

#### `business_hours`

- `workspace_id`
- `day_of_week`
- `enabled`
- `open_time`
- `close_time`

#### `ai_agents`

- `id`
- `workspace_id`
- `name`
- `status` — `DRAFT | ACTIVE | PAUSED`
- `tone`
- `primary_goal`
- `when_unsure`
- `advanced_instructions`
- `opening_message`
- `escalation_message`
- behavior settings JSONB

One active agent per workspace for MVP.

#### `services`

- `id`
- `workspace_id`
- `name`
- `description`
- `price_text`
- `duration_minutes`
- `active`

#### `faqs`

- `id`
- `workspace_id`
- `question`
- `answer`
- `active`

#### `policies`

- `id`
- `workspace_id`
- `type`
- `title`
- `content`

#### `knowledge_documents`

- `id`
- `workspace_id`
- `source_type` — `UPLOAD | WEBSITE | PASTED_TEXT`
- `source_url`
- `file_key`
- `title`
- `extracted_text`
- `status` — `PENDING | READY | FAILED`
- `metadata` JSONB

### Contacts, leads, conversations

#### `contacts`

- `id`
- `workspace_id`
- `name`
- `email`
- `phone`
- `notes`
- `created_at`
- `updated_at`

#### `contact_identities`

Allows the same person to match across channels.

- `id`
- `workspace_id`
- `contact_id`
- `channel` — `PHONE | SMS | WHATSAPP | WEBCHAT`
- `external_id`
- normalized identity value
- unique index on workspace/channel/value

#### `contact_tags`

- `contact_id`
- `tag`

#### `leads`

- `id`
- `workspace_id`
- `contact_id`
- `status` — `NEW | QUALIFIED | BOOKED | WON | LOST`
- `intent`
- `service_requested`
- `source`
- `estimated_value`
- `assigned_user_id`
- `updated_at`

#### `conversations`

- `id`
- `workspace_id`
- `contact_id`
- `status` — `OPEN | CLOSED`
- `handling_mode` — `AI | HUMAN`
- `assigned_user_id`
- `last_message_at`
- `ai_paused_at`
- `created_at`

There should normally be one open customer conversation that can span multiple channels.

#### `messages`

- `id`
- `workspace_id`
- `conversation_id`
- `channel`
- `direction` — `INBOUND | OUTBOUND | INTERNAL`
- `sender_type` — `CUSTOMER | AI | USER | SYSTEM`
- `content_type` — `TEXT | CALL_TRANSCRIPT | APPOINTMENT_EVENT | SYSTEM_EVENT`
- `body`
- `provider`
- `external_message_id`
- `status`
- `metadata` JSONB
- `created_at`

### Calls

#### `voice_calls`

- `id`
- `workspace_id`
- `conversation_id`
- `provider`
- `external_call_id`
- `mode` — `AI_FIRST | OVERFLOW | AFTER_HOURS`
- `status`
- `started_at`
- `ended_at`
- `duration_seconds`
- `transcript`
- metadata JSONB

No table or API for outbound AI campaigns is required.

### Appointments

#### `appointments`

- `id`
- `workspace_id`
- `contact_id`
- `conversation_id`
- `integration_id`
- `external_event_id`
- `service_id`
- `title`
- `starts_at`
- `ends_at`
- `timezone`
- `status` — `PENDING | CONFIRMED | COMPLETED | CANCELLED | NO_SHOW`
- `booking_source`
- `notes`
- `created_at`

### Integrations and provider routing

#### `integrations`

- `id`
- `workspace_id`
- `category` — `AI | COMMUNICATION | WHATSAPP | CALENDAR`
- `provider`
- `mode` — `HOSTED | BYOP`
- `status` — `CONNECTED | ERROR | DISCONNECTED`
- `encrypted_credentials` JSONB
- `settings` JSONB
- `last_tested_at`
- `last_error`

Never return decrypted credentials to the browser after save. The UI receives only masked metadata.

#### `capability_bindings`

This is the central routing table for hosted-vs-BYOP behavior.

- `workspace_id`
- `capability` — `AI_TEXT | SMS | VOICE | WHATSAPP | CALENDAR`
- `integration_id` nullable
- `mode` — `HOSTED | BYOP`

Example:

```text
AI          HOSTED      Our Credits
SMS         BYOP        Telnyx
VOICE       BYOP        Telnyx
WHATSAPP    BYOP        Meta
CALENDAR    BYOP        Calendly
```

### Automations

#### `automation_configs`

- `id`
- `workspace_id`
- `type` — `MISSED_INQUIRY | NEW_LEAD_RESPONSE | APPOINTMENT_CONFIRMATION | APPOINTMENT_REMINDER | HUMAN_ESCALATION`
- `enabled`
- `settings` JSONB
- `message_template`

Only these predefined types exist in Core.

#### `automation_runs`

- `id`
- `workspace_id`
- `automation_config_id`
- `subject_type`
- `subject_id`
- `status`
- `scheduled_for`
- `executed_at`
- `error`

### Credits and usage

#### `credit_wallets`

- `workspace_id`
- `balance`
- `updated_at`

#### `credit_ledger`

Immutable ledger.

- `id`
- `workspace_id`
- `type` — `GRANT | PURCHASE | DEBIT | REFUND | ADJUSTMENT`
- `amount`
- `balance_after`
- `reason`
- `reference_type`
- `reference_id`
- `created_at`

#### `usage_events`

- `id`
- `workspace_id`
- `capability`
- `provider`
- `mode` — `HOSTED | BYOP`
- internal provider usage JSONB
- `credits_charged`
- `reference_type`
- `reference_id`
- `created_at`

The UI exposes understandable credits and channel usage, not raw LLM/STT/TTS billing units.

### Reliability

#### `provider_webhook_events`

- `id`
- `provider`
- `external_event_id`
- `workspace_id`
- `payload` JSONB
- `status`
- `received_at`
- `processed_at`

Unique `(provider, external_event_id)` for idempotency.

---

## 6. Provider abstraction

The app must treat providers as replaceable pipes.

No provider SDK should leak into the orchestrator or page code.

### AI provider contract

```ts
interface AIProvider {
  generate(input: AIRequest): Promise<AIResponse>;
}
```

Adapters:

- hosted/default AI provider
- OpenAI BYOP
- Gemini BYOP
- OpenRouter BYOP

The orchestrator receives a normalized response regardless of provider.

### Calendar provider contract

This contract is directly dictated by the PRD:

```ts
interface CalendarProvider {
  getAvailability(input: AvailabilityRequest): Promise<TimeSlot[]>;
  book(input: BookingRequest): Promise<BookingResult>;
  reschedule(input: RescheduleRequest): Promise<BookingResult>;
  cancel(input: CancelRequest): Promise<void>;
}
```

Adapters:

- Google Calendar
- Microsoft Outlook
- Calendly
- Cal.com

### SMS provider contract

```ts
interface SMSProvider {
  send(input: SendTextRequest): Promise<SendResult>;
  verifyWebhook(request: Request): Promise<boolean>;
  normalizeWebhook(payload: unknown): Promise<NormalizedInboundEvent[]>;
}
```

Adapters:

- Telnyx
- Plivo
- Twilio

### WhatsApp provider contract

MVP adapter:

- Meta WhatsApp Cloud API

Only receive, reply, contact-match, and booking behaviors are required.

### Voice provider contract

```ts
interface VoiceProvider {
  verifyWebhook(request: Request): Promise<boolean>;
  normalizeCallEvent(payload: unknown): Promise<NormalizedCallEvent>;
  buildInboundResponse(input: InboundCallInstruction): Promise<ProviderVoiceResponse>;
}
```

Adapters should hide Twilio/Telnyx/Plivo call-control differences.

The application must contain **no outbound AI calling use case**.

---

## 7. Provider credential security

BYOP credentials are high-value secrets.

Rules:

1. Credentials are posted only over HTTPS.
2. Validate credentials by making the smallest safe provider API call.
3. Encrypt secrets before storing them.
4. Use authenticated encryption such as AES-256-GCM with a server-held master key.
5. Store nonce/IV and authentication tag with the encrypted value.
6. Never log credentials.
7. Never return the decrypted value after initial save.
8. UI displays masked state such as `••••••••last4` where useful.
9. Every provider webhook signature must be verified before processing.
10. Credential decryption only occurs inside the relevant provider adapter.

---

## 8. Normalized event model

Every inbound channel converts into the same internal event before business logic runs.

```ts
type InboundEvent = {
  id: string;
  workspaceId: string;
  type:
    | "SMS_RECEIVED"
    | "WHATSAPP_RECEIVED"
    | "WEBCHAT_MESSAGE"
    | "CALL_STARTED"
    | "CALL_TRANSCRIPT"
    | "CALL_ENDED";
  channel: "SMS" | "WHATSAPP" | "WEBCHAT" | "PHONE";
  provider: string;
  identity: string;
  text?: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
};
```

Webhook handlers should do as little as possible:

```text
verify signature
    -> store idempotency record
    -> normalize event
    -> enqueue/process event
    -> return provider acknowledgement quickly
```

Do not put the full AI flow directly inside provider webhook route handlers.

---

## 9. The orchestrator

The orchestrator is the core proprietary service.

For every normalized inbound event:

```text
1. Resolve workspace.
2. Resolve or create contact identity.
3. Resolve or create contact.
4. Resolve or create the open conversation.
5. Persist inbound message/event.
6. Check whether conversation is controlled by AI or human.
7. Load business + agent + relevant knowledge.
8. Determine provider route and credit mode.
9. Ask AI for response and/or tool calls.
10. Execute allowed tools.
11. Persist resulting state changes.
12. Persist outbound message.
13. Send response through the selected channel adapter.
14. Record usage/credits.
15. Trigger/schedule predefined automations.
```

### Allowed AI tools

Keep the tool surface small and explicit:

- `update_contact`
- `qualify_lead`
- `get_availability`
- `book_appointment`
- `reschedule_appointment`
- `cancel_appointment`
- `take_message`
- `escalate_to_human`

The AI must not receive arbitrary SQL, provider APIs, or unrestricted HTTP tools.

### Guardrails

Before a tool result reaches the customer:

- availability must come from the configured calendar provider;
- prices must come from configured services/knowledge;
- policies must come from business configuration;
- booking must be confirmed by the calendar adapter;
- if information is missing, follow `when_unsure` behavior;
- human handling mode always wins over AI.

---

## 10. AI context and knowledge

Do not start with a vector database.

MVP business knowledge is small enough to begin with structured context plus simple text retrieval.

### Context composition

For each AI turn, build context from:

1. agent behavior/system rules;
2. business name, location, hours, and service area;
3. relevant services and pricing text;
4. FAQs;
5. policies;
6. selected document/website excerpts;
7. contact/lead state;
8. recent conversation history;
9. current appointment information.

### Retrieval v1

- Structured fields are always included when relevant.
- Website/doc text is extracted and split into chunks.
- Use PostgreSQL full-text search or a simple scored text search first.
- Cap retrieved context aggressively.
- Add pgvector/vector search only if real data proves it is needed.

### Website import security

Website import must protect against SSRF:

- allow only `http` and `https`;
- resolve host and block private/internal IP ranges;
- enforce download-size and timeout limits;
- limit redirects;
- sanitize extracted content;
- never execute page JavaScript on the server merely to scrape text in V1.

---

## 11. Hosted credits + BYOP routing

This must be implemented before significant external API usage because it controls product economics.

### Resolution algorithm

For each capability:

```text
capability binding = workspace + capability

if binding.mode == BYOP:
    load integration
    decrypt credentials
    call provider
    record usage_event with credits_charged = 0
else:
    verify hosted credit balance
    call hosted provider
    calculate internal credit debit
    write immutable ledger debit
```

### Important rule

A failed provider call should not permanently consume customer credits unless the underlying billable provider operation actually occurred. Use debit/refund or finalize-after-success semantics per capability.

### Starter credits

Starter credits are granted once when a valid new FE account/workspace is activated.

---

## 12. Human takeover state machine

Keep it intentionally simple.

```text
AI handling
    |
    | Take Over
    v
Human handling
    |
    | Return to AI
    v
AI handling
```

When `handling_mode = HUMAN`:

- inbound messages still enter the timeline;
- AI does not send customer-facing replies;
- staff may reply through the same outbound channel;
- automations that would impersonate an active AI conversation should respect the human lock.

Escalation from the AI changes handling mode to `HUMAN` and creates a notification/activity item.

---

## 13. Website chat widget

This is the first channel we should make fully functional because it gives us the cheapest end-to-end test of the complete product.

### Embed design

The setup page provides something like:

```html
<script async src="https://app.example.com/widget.js" data-key="PUBLIC_WIDGET_KEY"></script>
```

Recommended implementation:

- `widget.js` injects an iframe so host-site CSS cannot break the widget;
- public widget key maps to one workspace;
- browser gets an anonymous visitor ID;
- POST endpoint accepts customer messages;
- Server-Sent Events or streaming HTTP sends AI responses back to the iframe;
- when customer provides phone/email, merge/update the contact;
- all messages enter the same unified conversation model.

Security:

- public widget token is not a secret but must be scoped to one workspace;
- rate-limit per IP + widget key;
- enforce message size limits;
- sanitize rendered content.

---

## 14. SMS implementation

Build SMS after web chat proves the orchestrator.

Flow:

```text
Provider webhook
 -> signature verification
 -> normalized SMS_RECEIVED
 -> orchestrator
 -> AI/tool execution
 -> SMS provider send()
 -> timeline + usage
```

Important U.S. production work such as sender registration/compliance must be handled in the provider setup flow before public launch. The code should expose provider connection health and delivery errors rather than pretending messages were delivered.

---

## 15. WhatsApp implementation

Use Meta WhatsApp Cloud API for the MVP.

Support only:

- incoming messages;
- AI replies;
- human replies;
- contact matching;
- booking links/tool calls;
- webhook delivery status where useful.

Do not build campaign/broadcast tooling.

The implementation must account for Meta message-window/template rules at the adapter layer so the orchestrator receives a normalized `canSend`/error result rather than Meta-specific details.

---

## 16. Inbound voice implementation

Voice is the most technically complex channel and should be implemented only after the text-channel orchestrator is stable.

### Modes

- `AI_FIRST`
- `OVERFLOW`
- `AFTER_HOURS`

### V1 voice architecture

```text
Inbound provider call
  -> provider webhook
  -> determine workspace + call mode
  -> start voice session
  -> media stream to Voice Gateway
  -> speech/AI runtime
  -> AI orchestrator tools when needed
  -> audio response
  -> transcript events saved to conversation
```

The `voice-gateway` is allowed to be a separate Node process because it needs long-lived streaming connections.

### Voice simplification

Do **not** require every BYOP LLM provider to implement realtime audio. Separate the concepts:

- telephony provider = phone transport;
- AI model provider = reasoning/tool decisions;
- voice runtime = STT/TTS/realtime audio implementation.

The first working voice runtime can use one known-good hosted stack behind an internal interface. Additional cost-optimized voice stacks can come later without changing the inbox/orchestrator.

### No outbound AI calling

There is no feature, route, queue job, or tool that starts an AI sales call to a customer.

An inbound call may be bridged/routed to staff as part of handling the inbound call, but we do not implement outbound AI campaigns.

---

## 17. Appointments

Appointments are local records synchronized with external scheduling systems.

Rules:

- external calendar is the source of truth for availability;
- our `appointments` row is the application/audit representation;
- provider webhook/sync updates local status where available;
- every booking links to contact and conversation;
- reschedule/cancel goes through the provider adapter before local state is finalized.

When the AI books:

```text
getAvailability()
 -> customer selects/AI confirms slot
 -> book()
 -> save local appointment
 -> set lead status BOOKED
 -> append appointment event to conversation
 -> schedule confirmation/reminder automation
```

---

## 18. Predefined automation engine

No visual workflow graph.

Use five fixed trigger handlers:

### Missed inquiry recovery

Trigger: unanswered/missed inbound inquiry after configured delay.

Action: send configured text message, then normal orchestrator handles any reply.

### New lead response

Trigger: newly created inbound lead/conversation.

Action: optional immediate templated/AI response based on channel.

### Appointment confirmation

Trigger: appointment successfully created.

Action: confirmation message.

### Appointment reminder

Trigger: scheduled time before appointment, default 24 hours.

Action: reminder message.

### Human escalation

Trigger: AI tool `escalate_to_human` or configured escalation condition.

Action: mark conversation HUMAN + notify staff.

### Job execution

pg-boss handles scheduled execution and retryable jobs.

Every automation job must be idempotent using a deterministic subject/action key so retries cannot send duplicate confirmations/reminders.

---

## 19. API surface mapped to the existing UI

Use ordinary REST/JSON Route Handlers plus Zod schemas. Do not add GraphQL or tRPC unless a real need emerges.

### Auth/onboarding

```text
POST   /api/auth/...
GET    /api/setup/status
PUT    /api/business
PUT    /api/business/hours
PUT    /api/agent
POST   /api/agent/services
POST   /api/agent/faqs
POST   /api/agent/policies
POST   /api/knowledge/import-url
POST   /api/knowledge/documents
POST   /api/setup/go-live
```

### Dashboard

```text
GET /api/dashboard?range=...
```

Returns the exact summary cards, charts, attention items, recent activity, and credit balance needed by the current dashboard.

### Inbox

```text
GET    /api/conversations
GET    /api/conversations/:id
POST   /api/conversations/:id/messages
POST   /api/conversations/:id/takeover
POST   /api/conversations/:id/return-to-ai
```

### Contacts

```text
GET    /api/contacts
POST   /api/contacts
GET    /api/contacts/:id
PATCH  /api/contacts/:id
POST   /api/contacts/:id/notes
POST   /api/contacts/:id/tags
```

### Appointments

```text
GET    /api/appointments
POST   /api/appointments
POST   /api/appointments/:id/reschedule
POST   /api/appointments/:id/cancel
```

### AI Agent

```text
GET    /api/agent
PATCH  /api/agent
GET    /api/agent/knowledge
POST   /api/agent/test
```

### Automations

```text
GET    /api/automations
PATCH  /api/automations/:type
GET    /api/automations/activity
```

### Integrations

```text
GET    /api/integrations
POST   /api/integrations/:provider/connect
POST   /api/integrations/:provider/test
PATCH  /api/integrations/:provider
DELETE /api/integrations/:provider
PUT    /api/integrations/bindings/:capability
```

### Usage/settings

```text
GET /api/usage
GET /api/credits
POST /api/credits/top-up          # implementation depends on product payment flow
GET /api/settings
PATCH /api/settings
GET /api/team
POST /api/team/invitations
```

### Provider webhooks

```text
POST /api/webhooks/telnyx
POST /api/webhooks/plivo
POST /api/webhooks/twilio
GET  /api/webhooks/whatsapp       # verification challenge where required
POST /api/webhooks/whatsapp
POST /api/webhooks/jvzoo
```

Webhook request/response details remain inside adapters.

---

## 20. JVZoo purchase / entitlement boundary

The sales funnel is external to the core app, but the backend needs a clean activation boundary.

Create a `CommerceAdapter` abstraction with JVZoo as the first implementation.

Responsibilities:

- validate purchase/IPN/webhook payload using the current official JVZoo specification when implementation begins;
- identify product/OTO purchased;
- create/update license record;
- grant entitlements;
- ensure starter credits are granted once;
- reject duplicate/replayed purchase events idempotently.

Do not hard-code funnel logic into page components.

---

## 21. Wiring strategy for the completed frontend

Do not rewrite the screens.

Each current page should be converted from local hard-coded sample state to three layers:

```text
Page component
  -> typed client hook/function
  -> /api route
  -> domain service / database
```

For each page, migration follows this pattern:

1. preserve current visual markup;
2. extract existing sample objects into typed API response types;
3. implement the backend endpoint returning the same shape;
4. replace sample arrays with fetched data;
5. wire mutations/actions;
6. add loading/empty/error states without redesigning the page;
7. add integration tests for the endpoint;
8. add one browser test for the critical user path.

This minimizes visual regressions while backend work proceeds.

---

## 22. Development milestones and order

This order is deliberate. It proves the core workflow early and postpones the hardest channel until the orchestration model is stable.

### Milestone 0 — Backend foundation

Branch: `feat/backend-foundation`

Deliver:

- PostgreSQL connection.
- Drizzle setup + migrations.
- Zod validation conventions.
- Better Auth integration.
- user/workspace/membership models.
- workspace scoping middleware/helpers.
- encrypted integration-secret utility.
- pg-boss setup + worker skeleton.
- structured logging.
- test framework.
- CI updated to run tests + typecheck + build.
- `.env.example` documenting required variables without secrets.

Acceptance:

- user can register/sign in/reset password;
- authenticated request resolves one workspace;
- database migrations run from empty DB;
- CI starts a test database and passes.

### Milestone 1 — Licensing, onboarding, business + agent persistence

Branch: `feat/account-onboarding-backend`

Deliver:

- license/entitlement model;
- JVZoo adapter boundary and a development/manual activation path;
- starter credit grant;
- business profile + hours endpoints;
- AI agent behavior endpoints;
- services/FAQs/policies CRUD;
- setup progress persistence;
- wire Sign Up, Sign In, Forgot Password, Welcome, Business, AI Setup.

Acceptance:

- a new account can complete setup steps 1–2 and reload without losing data;
- starter credits are granted exactly once;
- agent guardrails persist.

### Milestone 2 — Integrations + provider routing

Branch: `feat/provider-integrations`

Deliver:

- integrations table + encryption;
- capability bindings;
- provider registry/factory;
- AI provider adapters: hosted, OpenAI, Gemini, OpenRouter;
- calendar provider adapters: Google, Outlook, Calendly, Cal.com;
- communication credential forms: Telnyx, Plivo, Twilio;
- Meta WhatsApp credential form;
- test-connection endpoints;
- wire Integrations page + onboarding integration screens.

Acceptance:

- every designed integration panel saves/tests safely;
- secrets cannot be fetched back in plaintext;
- capability resolver correctly chooses Hosted vs BYOP.

### Milestone 3 — Contacts, leads, conversations, appointments

Branch: `feat/core-domain`

Deliver:

- contacts + identities;
- leads;
- conversations + messages;
- human/AI handling mode;
- appointments local model;
- calendar booking service;
- wire Contacts + Contact drawer + Appointments pages;
- initial Inbox reads from DB.

Acceptance:

- one contact can contain multiple channel identities;
- one conversation timeline can contain events from multiple channels;
- a calendar appointment can be booked/rescheduled/cancelled through normalized service methods.

### Milestone 4 — AI orchestrator + web chat vertical slice

Branch: `feat/orchestrator-webchat`

This is the first complete product slice.

Deliver:

- context builder;
- AI tool definitions;
- AI response orchestrator;
- lead qualification updates;
- booking tool integration;
- human escalation tool;
- website widget loader + iframe;
- widget public session/visitor identity;
- streaming/SSE response path;
- usage/credit debit integration;
- wire AI Agent Test tab and embed code.

Acceptance end-to-end:

```text
Visitor opens website widget
 -> asks a business question
 -> AI answers from configured knowledge
 -> AI qualifies intent
 -> AI checks calendar
 -> appointment is booked
 -> contact/lead/appointment are updated
 -> full timeline appears in Inbox
```

This milestone proves the product.

### Milestone 5 — SMS

Branch: `feat/sms-channel`

Deliver:

- first SMS provider adapter end to end, preferably the provider we choose as the hosted/default cost-efficient path;
- remaining Telnyx/Plivo/Twilio adapters behind same interface;
- webhook signature verification;
- inbound/outbound delivery status handling;
- BYOP routing;
- unified inbox timeline;
- hosted credit charging where applicable.

Acceptance:

- customer SMS can trigger the exact same orchestrator as web chat and book an appointment.

### Milestone 6 — WhatsApp

Branch: `feat/whatsapp-channel`

Deliver:

- Meta Cloud API webhooks;
- message receipt/reply;
- delivery status;
- identity resolution;
- template/window handling at adapter boundary;
- human reply from Inbox;
- BYOP usage reporting.

Acceptance:

- WhatsApp conversation appears in the same timeline and can transition between AI and human handling.

### Milestone 7 — Inbound voice + configurable qualification

Branch: `feat/inbound-voice`

Deliver:

- dedicated authenticated voice gateway process;
- Telnyx as the first inbound Call Control/media-stream adapter behind the provider boundary;
- recording-first call artifacts archived to private application-controlled storage;
- synchronized speaker/timestamp transcript persistence as a derived/searchable call view;
- recording/transcription disclosure policy with an explicit-consent option and auditable consent state;
- stable product voice profiles mapped to provider voice IDs, selectable by the workspace;
- shared orchestrator knowledge, lead, availability, booking, and escalation calls from voice sessions;
- configurable cross-channel lead qualification criteria with server-authoritative completion/qualification decisions;
- AI First mode;
- deterministic After Hours mode from the workspace timezone and business hours;
- Overflow deferred until AI First is fully stable and independently verifiable;
- authenticated recording playback and expandable transcript in the unified Inbox;
- voice usage accounting;
- Telnyx/Plivo/Twilio remain behind the provider capability boundary, but M7 only claims the implemented Telnyx inbound adapter.

Acceptance:

- an inbound caller reaches the AI assistant through a signed Telnyx webhook flow;
- recording does not begin before the configured disclosure/consent policy is satisfied;
- the caller can provide qualification evidence, ask a grounded business question, check availability, and book an appointment through the shared orchestrator;
- the lead is only marked qualified when configured required criteria are complete;
- the unified Inbox shows the archived playable recording as the primary call artifact with an expandable synchronized transcript;
- voice usage is recorded and After Hours routing is verified;
- existing web chat, SMS, WhatsApp, booking, and Inbox regression gates continue to pass.

There must still be no outbound AI calling feature, outbound call campaign, outbound call retry scheduler, or application tool capable of originating an AI call.

### Milestone 8 — Human takeover + predefined automations

Branch: `feat/automations-takeover`

Deliver:

- takeover/return-to-AI mutations;
- staff outbound replies;
- notification records;
- five predefined automation handlers;
- pg-boss scheduling/retries/idempotency;
- wire Automations page and right-side panels.

Acceptance:

- takeover immediately suppresses AI replies;
- return-to-AI resumes AI;
- confirmation and reminder jobs cannot duplicate on retry.

### Milestone 9 — Dashboard, usage, credits, settings

Branch: `feat/reporting-settings-backend`

Deliver:

- aggregated dashboard query;
- usage summaries by capability/provider;
- hosted-credit wallet and ledger UI;
- BYOP attribution text;
- channel settings;
- team CRUD/invitations at Core limits;
- wire Dashboard and all Settings tabs.

Acceptance:

Usage page can truthfully display mappings such as:

```text
AI          Our Credits
SMS         Telnyx — BYOP
Voice       Telnyx — BYOP
WhatsApp    Meta — BYOP
Calendar    Calendly
```

and current hosted credit balance.

### Milestone 10 — Hardening / release candidate

Branch: `release/mvp-rc`

Deliver:

- rate limiting;
- webhook replay/idempotency review;
- permission review;
- provider timeout/retry policy;
- credential security review;
- production email/reset flow;
- database backup policy;
- observability/error alerts;
- end-to-end test suite;
- load tests for widget/webhooks;
- failure-state UX;
- production deployment/runbook.

Acceptance:

All critical journeys pass against staging with real sandbox/test provider accounts.

---

## 23. Testing strategy

### Unit tests

Prioritize pure domain logic:

- lead state transitions;
- capability/provider resolver;
- credit calculations;
- business-hours logic;
- prompt/context construction;
- automation scheduling;
- entitlement enforcement.

### Integration tests

Against a test PostgreSQL database:

- every API mutation;
- workspace isolation;
- credit ledger transactions;
- contact identity matching;
- human takeover state;
- idempotent webhooks;
- booking transaction behavior.

Provider SDK calls should be replaced with fixture adapters in normal CI.

### Contract tests

Keep recorded/fixture payloads for each provider webhook and assert they normalize to the same internal event structure.

### E2E browser tests

Critical paths only:

1. purchase/dev activation -> signup -> onboarding;
2. configure AI/calendar -> web chat test -> booking;
3. Inbox takeover -> human reply -> return to AI;
4. connect BYOP provider -> Usage shows correct provider attribution;
5. appointment reschedule/cancel.

### Real-provider staging tests

Run separately from every PR because they use secrets and may incur costs.

---

## 24. Reliability rules

Every external provider operation needs:

- timeout;
- normalized error type;
- retry classification (`retryable` vs `permanent`);
- idempotency where provider supports it;
- correlation/request ID;
- safe logs without credentials/customer sensitive content where avoidable.

### Webhook rules

- verify first;
- deduplicate second;
- acknowledge quickly;
- process asynchronously when provider timeout windows are tight;
- never send a duplicate customer response because a provider retried a webhook.

---

## 25. Security checklist

Before production:

- all server mutations authenticate workspace membership;
- role checks for admin-only settings/integrations/team actions;
- encrypt BYOP credentials;
- password/reset flows delegated to tested auth library;
- CSRF/session protections enabled by auth framework;
- webhook signatures verified;
- widget rate limited;
- file upload MIME/size validation;
- website importer SSRF protections;
- HTML/message rendering escaped/sanitized;
- no secret values in client bundles;
- no raw provider secrets in logs;
- audit security-sensitive integration changes;
- delete/revoke credentials when integration is disconnected.

---

## 26. Performance principles

Do not optimize speculatively, but set sane boundaries:

- paginate contacts/conversations/messages;
- index all `workspace_id` foreign keys;
- index conversation `last_message_at`;
- index contact identity lookup;
- unique index provider external IDs where required;
- dashboard uses aggregation queries rather than loading all rows;
- cache business/agent static context briefly if profiling shows benefit;
- keep webhook response work minimal.

---

## 27. Frontend state and realtime updates

For normal screens, start with ordinary HTTP fetch/mutations.

Use realtime only where it matters:

- active Inbox conversation;
- website chat response stream;
- possibly call/test-session state.

Do not add a complex global realtime state layer for dashboard/settings pages.

For Inbox, Server-Sent Events are sufficient for V1 if deployed on a compatible long-running Node host. WebSockets can be introduced if bidirectional realtime requirements later justify them.

---

## 28. Migration rule for sample UI data

The existing UI contains static demo values. We must remove them systematically.

For every implemented page:

- no production code should silently fall back to fake contacts/messages/usage values;
- seed data belongs only in development fixtures;
- empty accounts render true empty states;
- loading states do not display fake metrics;
- API response types become the source of truth.

---

## 29. Feature gating

Implement a small `EntitlementService` now, not scattered plan checks.

```ts
entitlements.has("multiple_calendars")
entitlements.limit("workspace_count")
entitlements.limit("knowledge_items")
```

Core implementation only needs the FE limits. OTO1+ keys can exist as known constants but remain disabled until those milestones are intentionally built.

This gives the JVZoo funnel a clean technical foundation without contaminating MVP logic.

---

## 30. Definition of MVP done

We are not done because every page has an API.

We are done when these real journeys work reliably:

### Journey A — instant hosted setup

```text
Valid customer activates account
 -> receives starter credits
 -> configures business + AI + calendar
 -> installs web chat
 -> visitor asks question
 -> AI responds
 -> AI books appointment
 -> usage deducts credits
```

### Journey B — BYOP

```text
Business connects its own AI + communication provider
 -> capability binding switches to BYOP
 -> customer conversation works normally
 -> provider cost is not debited from hosted API credits
 -> Settings clearly says which provider powered the usage
```

### Journey C — unified customer

```text
Same customer uses WhatsApp, then SMS, then calls
 -> one contact
 -> one unified timeline
 -> phone transcript included
 -> appointment appears in same history
```

### Journey D — human takeover

```text
AI encounters escalation condition
 -> conversation becomes Human
 -> staff replies
 -> AI stays silent
 -> staff returns conversation to AI
 -> AI resumes on next inbound message
```

### Journey E — appointment lifecycle

```text
AI offers only real availability
 -> customer books
 -> confirmation is sent
 -> reminder is scheduled
 -> customer reschedules/cancels
 -> external calendar and local record stay aligned
```

### Journey F — inbound voice

```text
Customer calls inbound number
 -> AI answers according to configured mode
 -> grounded conversation occurs
 -> transcript stored
 -> booking/tool actions work
 -> no outbound AI call capability exists
```

---

## 31. Engineering decision rules for the remainder of the project

When choosing between two approaches, prefer the one that satisfies these rules in order:

1. Does it preserve the inquiry -> conversation -> qualification -> appointment workflow?
2. Is it provider-agnostic at the domain layer?
3. Is it inexpensive to operate for a JVZoo customer base?
4. Does it work with hosted credits and BYOP?
5. Can we ship it without adding a new infrastructure category?
6. Is it easy to understand and support?
7. Can the more sophisticated version wait for an OTO?

If a proposed feature does not improve the core workflow, it should probably not be in the MVP.

---

## 32. Immediate next step

The next coding milestone should be **Milestone 0 — Backend foundation** on a new branch from `main`.

We should not begin with Telnyx, OpenAI, WhatsApp, or calendar SDK code first. The first backend PR should establish:

- database;
- migrations;
- authentication;
- tenancy;
- encrypted secret storage;
- validation;
- job worker;
- testing/CI conventions.

Once that foundation is merged, every provider and frontend page can be implemented without repeatedly inventing infrastructure.
We are building an **AI Customer Communication & Booking Hub for local businesses**.

In one sentence:

> **A local business connects its phone, SMS, WhatsApp, website and calendar, and the system uses AI to answer inbound inquiries, qualify leads, book appointments and hand conversations to a human when necessary.**

The differentiator is not that we build the telecom, AI, or scheduling infrastructure ourselves. We **orchestrate inexpensive existing services** and let customers either use our included credits or connect their own providers.

## The MVP

The MVP only needs to solve this journey extremely well:

```text
Customer contacts business
        ↓
AI responds immediately
        ↓
Understands what they need
        ↓
Answers common questions
        ↓
Qualifies the inquiry
        ↓
Checks availability
        ↓
Books appointment
        ↓
Updates contact/lead record
        ↓
Human takes over if needed
```

That is the product.

### 1. Unified Inbox

One place for:

* SMS
* WhatsApp
* Website chat
* inbound phone conversations/transcripts

Each contact gets one timeline regardless of channel.

```text
John Smith

8:04 PM  Phone call
8:09 PM  SMS
8:12 PM  AI conversation
8:15 PM  Appointment booked
```

No complicated CRM.

Just:

**New → Qualified → Booked → Won/Lost**

---

### 2. AI Customer Agent

Every business creates one AI agent.

They provide:

* business name
* hours
* services
* pricing/price guidance
* location/service area
* FAQs
* policies
* booking rules
* escalation instructions

The AI can:

* answer questions
* determine intent
* capture customer details
* qualify leads
* offer appointments
* book/reschedule
* take a message
* transfer/escalate to staff

It must use the business's configured information rather than inventing prices, availability or policies.

---

### 3. Inbound AI Phone Answering

**Inbound only. No outbound AI calls.**

Three simple modes:

**AI First**

```text
Call → AI
```

**Overflow**

```text
Call → staff → unanswered → AI
```

**After Hours**

```text
Open → staff
Closed → AI
```

For MVP, support perhaps:

* **Plivo**
* **Telnyx**
* **Twilio**

But architect them behind one provider interface.

Don't build PBX software, complex call routing, call centers, queues, extensions, etc.

---

### 4. SMS

The system can continue conversations via SMS.

Example:

```text
Customer calls
↓
Call isn't completed / customer needs follow-up
↓
SMS conversation starts
↓
AI responds
↓
Appointment booked
```

SMS is especially important for the U.S. market.

---

### 5. WhatsApp

Include it.

Not because it needs to be the centerpiece of the U.S. pitch, but because it makes the product much more broadly useful internationally and gives businesses another inbound channel.

Use:

**WhatsApp Cloud API**

Don't build special WhatsApp campaign software in the MVP.

Just:

* receive messages
* AI reply
* human reply
* contact matching
* booking

---

### 6. Website Chat

Give the business a tiny script:

```html
<script src="..."></script>
```

That places an AI chat widget on its website.

Visitor:

> Do you repair AC units on Saturdays?

AI:

> Yes. Would you like me to check Saturday availability?

That leads directly to booking.

This is inexpensive for us and makes the software immediately demonstrable.

---

# 7. Booking

Support four systems:

* Google Calendar
* Microsoft Outlook Calendar
* Calendly
* Cal.com

But normalize them internally to only:

```text
getAvailability()

book()

reschedule()

cancel()
```

That's enough.

Do not build our own sophisticated appointment scheduling platform.

---

# 8. Lightweight Contacts + Leads

Do not build Salesforce.

We need:

### Contact

```text
Name
Phone
Email
Channel identities
Notes
Tags
```

### Lead

```text
Status
Intent
Service requested
Source
Estimated value
Assigned user
```

### Appointment

```text
Date
Time
Service
Calendar
Status
```

That's enough for V1.

---

# 9. Human Takeover

This is essential.

Staff can click:

> **Take Over Conversation**

AI pauses.

Staff replies.

Then:

> **Return to AI**

Simple.

No complex helpdesk system.

---

# 10. Basic Automations

This is an area where we could easily over-engineer.

Don't build Zapier.

MVP gets several predefined automations with simple configuration.

### Missed inquiry

```text
Missed inquiry
↓
Send SMS
↓
AI handles reply
```

### New web lead

```text
Form/chat
↓
AI starts conversation
```

### Appointment booked

```text
Booking
↓
Confirmation
```

### Appointment reminder

```text
24 hours before
↓
Reminder
```

### Human requested

```text
AI detects escalation
↓
Notify staff
```

Later, OTO1 can unlock an actual visual automation builder.

---

# 11. Knowledge Base

Don't build an elaborate RAG platform.

MVP:

Business can:

* type FAQs
* enter services
* enter policies
* paste website text
* optionally provide website URL
* upload a small number of documents

System turns that into AI context.

Simple.

---

# 12. BYOP + Our Credits

This is central to the economics.

When someone buys the product:

```text
Account
↓
Free starter credits
↓
Use immediately
```

No API setup necessary.

When credits run down:

```text
Option 1
Buy credits

Option 2
Subscribe for monthly credits

Option 3
Bring your own providers
```

### BYOP should support:

**AI**

* OpenAI
* Gemini
* OpenRouter

You don't need six AI providers at launch.

OpenRouter gives users access to many models through one integration anyway.

**Communication**

* Plivo
* Telnyx
* Twilio

**WhatsApp**

* Meta Cloud API

**Calendar**

* Google
* Outlook
* Calendly
* Cal.com

That's enough.

---

# 13. Usage & Credits

Keep this understandable.

Don't expose:

> 837 LLM tokens
> 47 seconds STT
> 2,154 TTS characters
> 3 carrier segments

That's confusing.

Create one internal currency:

# Credits

For example:

```text
AI text reply       X credits
AI voice minute     X credits
SMS                 X credits
WhatsApp AI reply   X credits
```

Exact numbers come from our provider-cost model.

The user sees:

```text
8,426 Credits Remaining
```

And if they're using BYOP:

```text
Powered by your OpenAI account
Powered by your Telnyx account

Platform credits not consumed.
```

Much easier.

---

# 14. Dashboard

Again, keep it outcome focused.

```text
Today

New Inquiries            31
AI Conversations         27
Qualified Leads          13
Appointments Booked       8
Human Takeovers            4
```

Then:

```text
Channels

Phone         12
SMS            7
WhatsApp       5
Web Chat       7
```

That's enough.

Don't build twenty analytics pages.

---

# The actual MVP navigation

I would aim for only:

```text
Dashboard

Inbox

Contacts

Appointments

AI Agent

Automations

Integrations

Settings
```

That's it.

If we end up with 20 sidebar items, we're probably overbuilding it.

---

# What is NOT in the MVP

This is important.

Do **not** build:

* outbound AI calling
* full CRM
* email marketing platform
* funnels
* landing-page builder
* social scheduling
* invoicing
* sales pipeline builder
* complex voice IVR/PBX
* advanced call-center features
* custom reporting builder
* dozens of CRM integrations
* sophisticated RAG administration
* advanced attribution
* old-lead reactivation
* visual workflow builder
* agency management
* white labeling
* SaaS reseller system

Most of those become upgrades.

---

# How the funnel fits the MVP

The underlying product remains one application.

We simply gate capabilities.

### FE — Core

**One business.**

Gets:

* AI agent
* inbox
* web chat
* SMS
* WhatsApp
* inbound AI voice
* one calendar connection
* contacts
* appointment booking
* basic automations
* human takeover
* starter credits
* BYOP

It is genuinely usable.

---

### OTO 1 — Unlimited

Unlocks the sophisticated functionality already built around the core:

* multiple calendar connections
* more phone/channel connections
* unlimited knowledge content
* advanced automations
* additional integrations
* webhooks/API
* multiple agents
* provider fallback
* higher software limits
* more bundled credits

Still **one business**.

---

### OTO 2 — Performance

This is where we add functionality specifically designed to produce more money:

**Lead Rescue**

**Database Reactivation**

**Revenue/Conversion Intelligence**

These do not need to contaminate the initial MVP.

---

### OTO 3 — Agency

Same engine.

Multiple client workspaces.

---

### OTO 4 — White Label

Branding + custom domain.

---

### OTO 5 — SaaS

Plans + customer provisioning + Stripe + billing controls.

---

# Technically, what are we building?

At the backend, it's actually pretty small conceptually.

```text
TENANT
   │
   ├── CONTACTS
   │
   ├── CONVERSATIONS
   │       │
   │       └── MESSAGES
   │
   ├── AI AGENT
   │
   ├── APPOINTMENTS
   │
   ├── AUTOMATIONS
   │
   └── INTEGRATIONS
```

Then an event comes in:

```text
SMS_RECEIVED
CALL_RECEIVED
WHATSAPP_RECEIVED
WEBCHAT_MESSAGE
APPOINTMENT_BOOKED
```

The orchestrator decides:

```text
Who is the contact?

What business?

What conversation?

Should AI reply?

What context does AI need?

Does it need a tool?

Book appointment?

Escalate?

Send response through which provider?
```

That **orchestrator is our proprietary product**.

Plivo isn't the product.

OpenAI isn't the product.

WhatsApp isn't the product.

Calendly isn't the product.

They are replaceable pipes.

---

# The MVP promise

I would reduce the entire product to this:

> ## **One AI-powered hub that answers your customers across phone, text, WhatsApp and web chat — and turns conversations into booked appointments.**

And our JVZoo cost angle:

> **Start instantly with included credits, or connect your own AI and communication providers to dramatically reduce ongoing costs.**

That's sophisticated enough to look impressive on a JVZoo sales page while still being **very buildable**.

The biggest discipline will be resisting the temptation to turn it into GoHighLevel. We don't need to replace a local business's entire software stack.

We only need to own one workflow exceptionally well:

# **Customer inquiry → conversation → qualification → appointment.**

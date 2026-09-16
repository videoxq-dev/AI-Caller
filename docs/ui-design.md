For the **FE/MVP**, I’d keep the product deliberately compact. We should design only the pages required to get someone from purchase → setup → live customer conversations → appointments.

I’d break it into **15 primary pages/screens**, with the onboarding flow treated as one guided experience.

### A. Entry & onboarding

1. **Sign In / Create Account**

   * Login
   * Account creation
   * Forgot password

2. **Welcome / Setup Checklist**

   * “Get your AI Assistant live”
   * Setup progress
   * Resume setup

3. **Business Profile**

   * Business details
   * Industry
   * Website
   * Business hours
   * Location/service area

4. **AI Assistant Setup**

   * Assistant name/personality
   * Goal
   * Services
   * FAQs
   * Policies
   * Website import
   * Advanced instructions

5. **Connect Communication**

   * Use our credits vs BYOP
   * Phone/SMS provider
   * WhatsApp
   * Website chat
   * Phone answering mode

6. **Connect Calendar**

   * Google
   * Outlook
   * Calendly
   * Cal.com
   * Booking rules

7. **Test & Go Live**

   * Chat simulator
   * Test phone call
   * Connection checklist
   * Go Live button

Those seven screens form the onboarding wizard.

---

### B. Main application

Once live, the sidebar should only have:

**Dashboard
Inbox
Contacts
Appointments
AI Agent
Automations
Integrations
Settings**

Which gives us these pages:

8. **Dashboard**

   * New inquiries
   * AI conversations
   * Qualified leads
   * Appointments
   * Human takeovers
   * Recent activity
   * Needs attention
   * Credit balance

9. **Inbox**

   * All customer conversations
   * SMS / WhatsApp / Phone / Web Chat
   * AI vs human handling
   * Customer information
   * Human takeover
   * Booking directly from conversation

This is probably the **most important page in the whole application**.

10. **Contacts**

* Contact list
* Search/filter
* Lead status
* Channel
* Last interaction
* Appointment status

11. **Contact Details**

* Contact information
* AI summary
* Unified conversation timeline
* Notes
* Lead information
* Appointments
* Tags

I would make this either a full page or large drawer depending on the UI direction.

12. **Appointments**

* Upcoming appointments
* List/calendar view
* Booking source
* Open customer conversation
* Reschedule/cancel

13. **AI Agent**
    This can be one page with tabs:

**Overview | Knowledge | Behavior | Test**

Rather than four separate sidebar pages.

14. **Automations**

* Missed inquiry recovery
* New lead response
* Appointment confirmation
* Appointment reminder
* Human escalation
* Simple settings for each automation

For FE, these are predefined workflows—not a visual workflow builder.

15. **Integrations**
    App-store-style interface:

**Communication**

* Plivo
* Telnyx
* Twilio
* WhatsApp

**AI**

* Our Credits
* OpenAI
* Gemini
* OpenRouter

**Scheduling**

* Google
* Outlook
* Calendly
* Cal.com

16. **Settings**

Rather than lots of separate pages, use tabs:

**General | Team | Channels | Usage & Credits | Billing**

Usage & Credits is especially important because it should clearly show:

```text
AI             Our Credits
SMS            Telnyx — BYOP
Voice          Telnyx — BYOP
WhatsApp       Meta — BYOP
Calendar       Calendly
```

Plus remaining hosted credits.

---

# So our actual application map is very small

```text
ONBOARDING
│
├── Welcome
├── Business Profile
├── AI Assistant
├── Communication
├── Calendar
└── Test & Go Live


APPLICATION
│
├── Dashboard
│
├── Inbox
│
├── Contacts
│    └── Contact Details
│
├── Appointments
│
├── AI Agent
│    ├── Overview
│    ├── Knowledge
│    ├── Behavior
│    └── Test
│
├── Automations
│
├── Integrations
│
└── Settings
     ├── General
     ├── Team
     ├── Channels
     ├── Usage & Credits
     └── Billing
```

### Pages we should **not design yet**

We should leave these until their respective OTOs:

**Performance**

* Lead Rescue dashboard
* Reactivation campaigns
* Revenue intelligence

**Agency**

* Clients
* Client workspace switcher
* Agency dashboard

**White Label**

* Branding
* Custom domain

**SaaS**

* Plans
* Subscribers
* Billing configuration

That prevents us designing OTO functionality before the core product itself is right.

## Design order I recommend

I'd actually design them in this order:

**1. Dashboard → 2. Inbox → 3. AI Agent → 4. Appointments → 5. Contacts → 6. Integrations → 7. Automations → 8. Settings → 9. Onboarding.**

Starting with **Dashboard** establishes the visual language and navigation, while **Inbox** establishes the product's most important interaction model.

**Let's start with the Dashboard.** I can define the exact layout, sections, cards, hierarchy, navigation and what every component on that page should do.

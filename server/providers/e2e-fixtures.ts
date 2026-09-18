import { randomUUID } from "node:crypto";
import type { AIProvider, CalendarProvider, SMSProvider, VoiceProvider, WhatsAppProvider } from "./contracts";

function nextUtcDay(hour: number, minute = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hour, minute, 0, 0));
}

export function isE2EProviderFixtureMode() {
  if (process.env.CI !== "true" || process.env.AI_CALLER_E2E_FIXTURES !== "1") return false;
  try {
    const host = new URL(process.env.BETTER_AUTH_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

export function createE2EAIProvider(): AIProvider {
  if (!isE2EProviderFixtureMode()) throw new Error("E2E provider fixtures are not available outside guarded CI localhost mode.");
  return {
    async generate({ messages }) {
      const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const lastUser = lastUserMessage.toLowerCase();
      const toolResult = [...messages].reverse().find((message) => message.role === "system" && message.content.includes("SERVER TOOL RESULT"))?.content;

      if (toolResult) {
        if (toolResult.includes('"kind":"booking"')) {
          return { text: JSON.stringify({ reply: "Your QA Consultation is booked for 10:00 AM tomorrow.", action: { type: "NONE" } }) };
        }
        if (toolResult.includes('"kind":"availability"')) {
          return { text: JSON.stringify({ reply: "I have a 10:00 AM opening tomorrow.", action: { type: "NONE" } }) };
        }
        if (toolResult.includes('"kind":"qualification"')) {
          const configuredPrice = system.match(/- QA Consultation\s+—\s+([^:\n]+)/)?.[1]?.trim() ?? "$120";
          return { text: JSON.stringify({ reply: `QA Consultation is ${configuredPrice}. I can also check tomorrow's availability.`, action: { type: "NONE" } }) };
        }
      }

      if (system.includes("LEAD QUALIFICATION") && lastUser.includes("qa consultation") && (lastUser.includes("today") || lastUser.includes("urgent"))) {
        return {
          text: JSON.stringify({
            lead: { intent: "Interested in QA Consultation", serviceRequested: "QA Consultation" },
            action: {
              type: "QUALIFY_LEAD",
              answers: [
                { criterionId: "service_needed", answer: "QA Consultation" },
                { criterionId: "urgency", answer: "Today" },
              ],
            },
          }),
        };
      }

      if (lastUser.includes("available") || lastUser.includes("availability") || lastUser.includes("time")) {
        return {
          text: JSON.stringify({
            lead: { status: "QUALIFIED", intent: "Book a QA consultation", serviceRequested: "QA Consultation" },
            action: {
              type: "CHECK_AVAILABILITY",
              startsAt: nextUtcDay(9).toISOString(),
              endsAt: nextUtcDay(17).toISOString(),
              timezone: "UTC",
              durationMinutes: 30,
            },
          }),
        };
      }

      if (lastUser.includes("book")) {
        const email = lastUserMessage.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "qa.visitor@example.com";
        const explicitName = lastUserMessage.match(/my name is\s+([^,.]+)[,.]?/i)?.[1]?.trim() ?? "QA Visitor";
        return {
          text: JSON.stringify({
            contact: { name: explicitName, email },
            lead: { status: "QUALIFIED", intent: "Book a QA consultation", serviceRequested: "QA Consultation" },
            action: {
              type: "BOOK_APPOINTMENT",
              startsAt: nextUtcDay(10).toISOString(),
              endsAt: nextUtcDay(10, 30).toISOString(),
              timezone: "UTC",
              title: "QA Consultation",
              serviceId: null,
              notes: "Booked by browser acceptance verification.",
            },
          }),
        };
      }

      const configuredPrice = system.match(/- QA Consultation\s+—\s+([^:\n]+)/)?.[1]?.trim();
      if (!configuredPrice) throw new Error("E2E AI fixture did not receive the configured QA Consultation knowledge.");
      return {
        text: JSON.stringify({
          reply: `QA Consultation is ${configuredPrice}. I can also check tomorrow's availability.`,
          lead: { status: "QUALIFIED", intent: "Interested in QA Consultation", serviceRequested: "QA Consultation" },
          action: { type: "NONE" },
        }),
      };
    },
  };
}

export function createE2ECalendarProvider(): CalendarProvider {
  if (!isE2EProviderFixtureMode()) throw new Error("E2E provider fixtures are not available outside guarded CI localhost mode.");
  return {
    async getAvailability(input) {
      const slot = { startsAt: nextUtcDay(10), endsAt: nextUtcDay(10, 30) };
      if (slot.startsAt < input.startsAt || slot.endsAt > input.endsAt) return [];
      return [slot];
    },
    async book(input) {
      if (!input.attendeeEmail) throw new Error("E2E calendar fixture requires the same attendee email needed by Cal.com.");
      return { externalId: `e2e-${randomUUID()}`, startsAt: input.startsAt, endsAt: input.endsAt };
    },
    async reschedule(input) {
      return { externalId: input.externalId, startsAt: input.startsAt, endsAt: input.endsAt };
    },
    async cancel() {},
  };
}

export function createE2ESmsProvider(base: SMSProvider): SMSProvider {
  if (!isE2EProviderFixtureMode()) throw new Error("E2E provider fixtures are not available outside guarded CI localhost mode.");
  return {
    verifyWebhook: (input) => base.verifyWebhook(input),
    normalizeWebhook: (input) => base.normalizeWebhook(input),
    async send(input) {
      return {
        externalId: `e2e-sms-${input.idempotencyKey ?? randomUUID()}`,
        status: "QUEUED",
      };
    },
  };
}

export function createE2EWhatsAppProvider(base: WhatsAppProvider): WhatsAppProvider {
  if (!isE2EProviderFixtureMode()) throw new Error("E2E provider fixtures are not available outside guarded CI localhost mode.");
  return {
    verifyWebhook: (input) => base.verifyWebhook(input),
    normalizeWebhook: (input) => base.normalizeWebhook(input),
    async sendText() {
      return { externalId: `e2e-wa-${randomUUID()}`, status: "SENT" };
    },
    async sendTemplate() {
      return { externalId: `e2e-wa-template-${randomUUID()}`, status: "SENT" };
    },
  };
}


export function createE2EVoiceProvider(base: VoiceProvider): VoiceProvider {
  if (!isE2EProviderFixtureMode()) throw new Error("E2E provider fixtures are not available outside guarded CI localhost mode.");
  return {
    verifyWebhook: (input) => base.verifyWebhook(input),
    normalizeWebhook: (input) => base.normalizeWebhook(input),
    async answer() {},
    async gatherConsent() {},
    async startTranscription() {},
    async startRecording() {},
    async speak() {},
    async hangup() {},
  };
}

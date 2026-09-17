import type { CalendarProvider } from "../contracts";
import { providerJson } from "../http";
import {
  decryptCredentials,
  numberSetting,
  requireCredential,
  stringSetting,
  type CalendarInput,
  type Credentials,
  type RuntimeSettings,
} from "./helpers";

export class CalendlyCalendarProvider implements CalendarProvider {
  private readonly credentials: Credentials;
  private readonly settings: RuntimeSettings;

  constructor(input: CalendarInput, private readonly fetcher: typeof fetch = fetch) {
    this.credentials = decryptCredentials(input);
    this.settings = { ...input.settings, ...input.runtimeSettings };
  }

  private token() {
    return requireCredential(this.credentials, "token", "Calendly Personal Access Token");
  }

  private eventType() {
    const value = stringSetting(this.settings, "eventTypeUri", "eventType");
    if (!value || !value.startsWith("https://api.calendly.com/event_types/")) {
      throw new Error("Choose a Calendly event type before using calendar booking.");
    }
    return value;
  }

  async getAvailability(input: { startsAt: Date; endsAt: Date; timezone: string; durationMinutes?: number }) {
    const query = new URLSearchParams({
      event_type: this.eventType(),
      start_time: input.startsAt.toISOString(),
      end_time: input.endsAt.toISOString(),
    });
    const response = await providerJson<{ collection?: Array<{ status?: string; start_time?: string }> }>(
      `https://api.calendly.com/event_type_available_times?${query.toString()}`,
      { headers: { authorization: `Bearer ${this.token()}` } },
      this.fetcher,
    );
    const durationMs = (input.durationMinutes ?? numberSetting(this.settings, "meetingDurationMinutes", 30)) * 60_000;
    return (response.collection ?? [])
      .filter((slot) => slot.status === "available" && slot.start_time)
      .map((slot) => {
        const startsAt = new Date(slot.start_time!);
        return { startsAt, endsAt: new Date(startsAt.getTime() + durationMs) };
      });
  }

  async book(input: { startsAt: Date; endsAt: Date; timezone: string; title: string; attendeeName?: string; attendeeEmail?: string }) {
    if (!input.attendeeEmail) throw new Error("Calendly requires an attendee email address to create a booking.");
    const response = await providerJson<{ resource?: { event?: string } }>("https://api.calendly.com/invitees", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({
        event_type: this.eventType(),
        start_time: input.startsAt.toISOString(),
        invitee: {
          email: input.attendeeEmail,
          name: input.attendeeName,
          timezone: input.timezone,
        },
      }),
    }, this.fetcher);
    const eventUri = response.resource?.event;
    const externalId = eventUri?.split("/").filter(Boolean).pop();
    if (!externalId) throw new Error("Calendly did not return a scheduled event ID.");
    return { externalId, startsAt: input.startsAt, endsAt: input.endsAt };
  }

  async reschedule(_input: { externalId: string; startsAt: Date; endsAt: Date; timezone: string }) {
    throw new Error("Calendly does not expose direct API rescheduling. Use its invitee reschedule URL or cancel and rebook explicitly.");
  }

  async cancel(input: { externalId: string }) {
    await providerJson<unknown>(`https://api.calendly.com/scheduled_events/${encodeURIComponent(input.externalId)}/cancellation`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Cancelled through AI Caller" }),
    }, this.fetcher);
  }
}

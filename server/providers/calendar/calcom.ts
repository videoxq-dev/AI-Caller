import { getEnv } from "@/server/env";
import type { CalendarProvider } from "../contracts";
import { providerJson } from "../http";
import {
  decryptCredentials,
  numberSetting,
  parseDate,
  requireCredential,
  stringSetting,
  type CalendarInput,
  type Credentials,
  type RuntimeSettings,
} from "./helpers";

export class CalComCalendarProvider implements CalendarProvider {
  private readonly credentials: Credentials;
  private readonly settings: RuntimeSettings;

  constructor(input: CalendarInput, private readonly fetcher: typeof fetch = fetch) {
    this.credentials = decryptCredentials(input);
    this.settings = { ...input.settings, ...input.runtimeSettings };
  }

  private token() {
    return requireCredential(this.credentials, "apiKey", "Cal.com API key");
  }

  private headers(version: string, includeJson = false) {
    return {
      authorization: `Bearer ${this.token()}`,
      "cal-api-version": version,
      ...(includeJson ? { "content-type": "application/json" } : {}),
    };
  }

  private eventTypeSlug() {
    const value = stringSetting(this.settings, "eventTypeSlug", "eventType");
    if (!value) throw new Error("Choose a Cal.com event type before using calendar booking.");
    return value;
  }

  private username() {
    const value = stringSetting(this.settings, "username", "slug");
    if (!value) throw new Error("A Cal.com username is required.");
    return value;
  }

  async getAvailability(input: { startsAt: Date; endsAt: Date; timezone: string; durationMinutes?: number }) {
    const duration = input.durationMinutes ?? numberSetting(this.settings, "meetingDurationMinutes", 30);
    const query = new URLSearchParams({
      username: this.username(),
      eventTypeSlug: this.eventTypeSlug(),
      start: input.startsAt.toISOString(),
      end: input.endsAt.toISOString(),
      timeZone: input.timezone,
      duration: String(duration),
      format: "range",
    });
    const response = await providerJson<{ data?: Record<string, Array<{ start?: string; end?: string }>> }>(
      `https://api.cal.com/v2/slots?${query.toString()}`,
      { headers: this.headers(getEnv().CALCOM_SLOTS_API_VERSION) },
      this.fetcher,
    );
    const durationMs = duration * 60_000;
    return Object.values(response.data ?? {}).flat().filter((slot) => slot.start).map((slot) => {
      const startsAt = new Date(slot.start!);
      const endsAt = slot.end ? new Date(slot.end) : new Date(startsAt.getTime() + durationMs);
      return { startsAt, endsAt };
    });
  }

  async book(input: { startsAt: Date; endsAt: Date; timezone: string; title: string; attendeeName?: string; attendeeEmail?: string }) {
    if (!input.attendeeEmail) throw new Error("Cal.com requires an attendee email address to create a booking.");
    const response = await providerJson<{ data?: { uid?: string; start?: string; end?: string } }>("https://api.cal.com/v2/bookings", {
      method: "POST",
      headers: this.headers(getEnv().CALCOM_BOOKINGS_API_VERSION, true),
      body: JSON.stringify({
        eventTypeSlug: this.eventTypeSlug(),
        username: this.username(),
        start: input.startsAt.toISOString(),
        attendee: {
          name: input.attendeeName ?? input.attendeeEmail,
          email: input.attendeeEmail,
          timeZone: input.timezone,
          language: "en",
        },
      }),
    }, this.fetcher);
    if (!response.data?.uid) throw new Error("Cal.com did not return a booking UID.");
    return {
      externalId: response.data.uid,
      startsAt: parseDate(response.data.start, input.startsAt),
      endsAt: parseDate(response.data.end, input.endsAt),
    };
  }

  async reschedule(input: { externalId: string; startsAt: Date; endsAt: Date; timezone: string }) {
    const response = await providerJson<{ data?: { uid?: string; start?: string; end?: string } }>(
      `https://api.cal.com/v2/bookings/${encodeURIComponent(input.externalId)}/reschedule`,
      {
        method: "POST",
        headers: this.headers(getEnv().CALCOM_BOOKINGS_API_VERSION, true),
        body: JSON.stringify({ start: input.startsAt.toISOString(), reschedulingReason: "Rescheduled through AI Caller" }),
      },
      this.fetcher,
    );
    return {
      externalId: response.data?.uid ?? input.externalId,
      startsAt: parseDate(response.data?.start, input.startsAt),
      endsAt: parseDate(response.data?.end, input.endsAt),
    };
  }

  async cancel(input: { externalId: string }) {
    await providerJson<unknown>(`https://api.cal.com/v2/bookings/${encodeURIComponent(input.externalId)}/cancel`, {
      method: "POST",
      headers: this.headers(getEnv().CALCOM_BOOKINGS_API_VERSION, true),
      body: JSON.stringify({ cancellationReason: "Cancelled through AI Caller" }),
    }, this.fetcher);
  }
}

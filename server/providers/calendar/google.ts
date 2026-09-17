import type { CalendarProvider } from "../contracts";
import { providerJson } from "../http";
import {
  decryptCredentials,
  googleAccessToken,
  numberSetting,
  parseDate,
  requireCredential,
  slotize,
  stringSetting,
  type CalendarInput,
  type Credentials,
  type RuntimeSettings,
} from "./helpers";

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly credentials: Credentials;
  private readonly settings: RuntimeSettings;

  constructor(private readonly input: CalendarInput, private readonly fetcher: typeof fetch = fetch) {
    this.credentials = decryptCredentials(input);
    this.settings = { ...input.settings, ...input.runtimeSettings };
  }

  private async token() {
    return googleAccessToken(requireCredential(this.credentials, "refreshToken", "Google OAuth refresh token"), this.fetcher);
  }

  private calendarId() {
    return stringSetting(this.settings, "calendar", "calendarId") ?? "primary";
  }

  async getAvailability(input: { startsAt: Date; endsAt: Date; timezone: string; durationMinutes?: number }) {
    const token = await this.token();
    const calendarId = this.calendarId();
    const response = await providerJson<{ calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }> }>(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          timeMin: input.startsAt.toISOString(),
          timeMax: input.endsAt.toISOString(),
          timeZone: input.timezone,
          items: [{ id: calendarId }],
        }),
      },
      this.fetcher,
    );

    const busy = (response.calendars?.[calendarId]?.busy ?? []).map((item) => ({
      startsAt: parseDate(item.start, input.startsAt),
      endsAt: parseDate(item.end, input.endsAt),
    }));
    return slotize(input.startsAt, input.endsAt, busy, input.durationMinutes ?? numberSetting(this.settings, "meetingDurationMinutes", 30));
  }

  async book(input: { startsAt: Date; endsAt: Date; timezone: string; title: string; attendeeName?: string; attendeeEmail?: string }) {
    const token = await this.token();
    const response = await providerJson<{ id?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId())}/events`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          summary: input.title,
          start: { dateTime: input.startsAt.toISOString(), timeZone: input.timezone },
          end: { dateTime: input.endsAt.toISOString(), timeZone: input.timezone },
          ...(input.attendeeEmail ? { attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName }] } : {}),
        }),
      },
      this.fetcher,
    );
    if (!response.id) throw new Error("Google Calendar did not return an event ID.");
    return {
      externalId: response.id,
      startsAt: parseDate(response.start?.dateTime, input.startsAt),
      endsAt: parseDate(response.end?.dateTime, input.endsAt),
    };
  }

  async reschedule(input: { externalId: string; startsAt: Date; endsAt: Date; timezone: string }) {
    const token = await this.token();
    const response = await providerJson<{ id?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId())}/events/${encodeURIComponent(input.externalId)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          start: { dateTime: input.startsAt.toISOString(), timeZone: input.timezone },
          end: { dateTime: input.endsAt.toISOString(), timeZone: input.timezone },
        }),
      },
      this.fetcher,
    );
    return {
      externalId: response.id ?? input.externalId,
      startsAt: parseDate(response.start?.dateTime, input.startsAt),
      endsAt: parseDate(response.end?.dateTime, input.endsAt),
    };
  }

  async cancel(input: { externalId: string }) {
    const token = await this.token();
    await providerJson<unknown>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId())}/events/${encodeURIComponent(input.externalId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      this.fetcher,
    );
  }
}

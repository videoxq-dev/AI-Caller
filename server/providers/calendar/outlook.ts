import type { CalendarProvider } from "../contracts";
import { providerJson } from "../http";
import {
  decryptCredentials,
  microsoftAccessToken,
  numberSetting,
  parseDate,
  requireCredential,
  slotize,
  stringSetting,
  toUtcLocalString,
  type CalendarInput,
  type Credentials,
  type RuntimeSettings,
} from "./helpers";

export class OutlookCalendarProvider implements CalendarProvider {
  private readonly credentials: Credentials;
  private readonly settings: RuntimeSettings;

  constructor(private readonly input: CalendarInput, private readonly fetcher: typeof fetch = fetch) {
    this.credentials = decryptCredentials(input);
    this.settings = { ...input.settings, ...input.runtimeSettings };
  }

  private async token() {
    return microsoftAccessToken(requireCredential(this.credentials, "refreshToken", "Microsoft OAuth refresh token"), this.fetcher);
  }

  private calendarId() {
    return stringSetting(this.settings, "calendar", "calendarId");
  }

  private calendarViewPath() {
    const calendarId = this.calendarId();
    return calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/calendarView` : "/me/calendarView";
  }

  private eventsPath() {
    const calendarId = this.calendarId();
    return calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/events` : "/me/events";
  }

  async getAvailability(input: { startsAt: Date; endsAt: Date; timezone: string; durationMinutes?: number }) {
    const token = await this.token();
    const query = new URLSearchParams({
      startDateTime: input.startsAt.toISOString(),
      endDateTime: input.endsAt.toISOString(),
      "$select": "start,end,isCancelled,showAs",
    });
    type OutlookEvent = {
      isCancelled?: boolean;
      showAs?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
    };
    type OutlookPage = { value?: OutlookEvent[]; "@odata.nextLink"?: string };
    let url: string | null = `https://graph.microsoft.com/v1.0${this.calendarViewPath()}?${query.toString()}`;
    const busy: Array<{ startsAt: Date; endsAt: Date }> = [];
    const visited = new Set<string>();
    for (let page = 0; url !== null; page++) {
      if (page >= 30 || visited.has(url)) throw new Error("Microsoft Calendar availability response was incomplete.");
      visited.add(url);
      const response: OutlookPage = await providerJson<OutlookPage>(
        url,
        { headers: { authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } },
        this.fetcher,
      );
      if (!Array.isArray(response.value)) throw new Error("Microsoft Calendar did not return a complete availability response.");
      for (const event of response.value) {
        if (event.isCancelled || event.showAs === "free") continue;
        const start = event.start?.dateTime, end = event.end?.dateTime;
        if (!start || !end) throw new Error("Microsoft Calendar returned an event without a valid time range.");
        const startsAt = parseDate(start, new Date(NaN));
        const endsAt = parseDate(end, new Date(NaN));
        if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) {
          throw new Error("Microsoft Calendar returned an invalid event interval.");
        }
        busy.push({ startsAt, endsAt });
        if (busy.length > 10_000) throw new Error("Microsoft Calendar returned too many events to check availability safely.");
      }
      if (!response["@odata.nextLink"]) {
        url = null;
      } else {
        const next = new URL(response["@odata.nextLink"]);
        if (next.origin !== "https://graph.microsoft.com" ||
          !next.pathname.startsWith("/v1.0/me/")) {
          throw new Error("Microsoft Calendar returned an invalid pagination URL.");
        }
        url = next.toString();
      }
    }
    return slotize(input.startsAt, input.endsAt, busy, input.durationMinutes ?? numberSetting(this.settings, "meetingDurationMinutes", 30));
  }

  async book(input: { startsAt: Date; endsAt: Date; timezone: string; title: string; attendeeName?: string; attendeeEmail?: string }) {
    const token = await this.token();
    const response = await providerJson<{ id?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }>(
      `https://graph.microsoft.com/v1.0${this.eventsPath()}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", Prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify({
          subject: input.title,
          start: { dateTime: toUtcLocalString(input.startsAt), timeZone: "UTC" },
          end: { dateTime: toUtcLocalString(input.endsAt), timeZone: "UTC" },
          ...(input.attendeeEmail ? {
            attendees: [{
              emailAddress: { address: input.attendeeEmail, name: input.attendeeName ?? input.attendeeEmail },
              type: "required",
            }],
          } : {}),
        }),
      },
      this.fetcher,
    );
    if (!response.id) throw new Error("Microsoft Graph did not return an event ID.");
    return {
      externalId: response.id,
      startsAt: parseDate(response.start?.dateTime, input.startsAt),
      endsAt: parseDate(response.end?.dateTime, input.endsAt),
    };
  }

  async reschedule(input: { externalId: string; startsAt: Date; endsAt: Date; timezone: string }) {
    const token = await this.token();
    const response = await providerJson<{ id?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }>(
      `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(input.externalId)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", Prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify({
          start: { dateTime: toUtcLocalString(input.startsAt), timeZone: "UTC" },
          end: { dateTime: toUtcLocalString(input.endsAt), timeZone: "UTC" },
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
      `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(input.externalId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      this.fetcher,
    );
  }
}

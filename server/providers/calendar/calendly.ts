import type { CalendarProvider } from "../contracts";
import { providerJson } from "../http";
import {
  decryptCredentials,
  requireCredential,
  stringSetting,
  type CalendarInput,
  type Credentials,
  type RuntimeSettings,
} from "./helpers";

type CalendlyEventType = {
  active?: boolean;
  name?: string;
  slug?: string;
  uri?: string;
  scheduling_url?: string;
  duration?: number;
};

type CalendlyInvitee = {
  email?: string;
  name?: string;
  timezone?: string;
  status?: string;
};

type CalendlyCreateInviteeResponse = {
  resource?: {
    event?: string;
    uri?: string;
  };
};

function normalized(value: string | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function eventIdFromUri(uri: string | undefined) {
  return uri?.split("/").filter(Boolean).pop();
}

function scheduledEventIdFromInvitee(response: CalendlyCreateInviteeResponse) {
  const direct = eventIdFromUri(response.resource?.event);
  if (direct) return direct;

  const inviteeUri = response.resource?.uri;
  if (!inviteeUri) return undefined;
  try {
    const parts = new URL(inviteeUri).pathname.split("/").filter(Boolean);
    const eventIndex = parts.indexOf("scheduled_events");
    return eventIndex >= 0 ? parts[eventIndex + 1] : undefined;
  } catch {
    return undefined;
  }
}

export class CalendlyCalendarProvider implements CalendarProvider {
  private readonly credentials: Credentials;
  private readonly settings: RuntimeSettings;
  private resolvedEventType?: { uri: string; duration: number };

  constructor(input: CalendarInput, private readonly fetcher: typeof fetch = fetch) {
    this.credentials = decryptCredentials(input);
    this.settings = { ...input.settings, ...input.runtimeSettings };
  }

  private token() {
    return requireCredential(this.credentials, "token", "Calendly Personal Access Token");
  }

  private headers(includeJson = false) {
    return {
      authorization: `Bearer ${this.token()}`,
      ...(includeJson ? { "content-type": "application/json" } : {}),
    };
  }

  private async eventType() {
    if (this.resolvedEventType) return this.resolvedEventType;

    const configured = stringSetting(this.settings, "eventTypeUri", "eventType");
    if (configured?.startsWith("https://api.calendly.com/event_types/")) {
      const event = await providerJson<{ resource?: CalendlyEventType }>(
        configured,
        { headers: this.headers() },
        this.fetcher,
      );
      const duration = event.resource?.duration;
      if (event.resource?.active === false || !event.resource?.uri ||
        !Number.isSafeInteger(duration) || !duration || duration < 1 || duration > 720) {
        throw new Error("The configured Calendly event type is inactive or has no valid duration.");
      }
      this.resolvedEventType = { uri: event.resource.uri, duration };
      return this.resolvedEventType;
    }

    const me = await providerJson<{ resource?: { uri?: string } }>(
      "https://api.calendly.com/users/me",
      { headers: this.headers() },
      this.fetcher,
    );
    const userUri = me.resource?.uri;
    if (!userUri) throw new Error("Calendly did not return the connected user URI.");

    const query = new URLSearchParams({ user: userUri, active: "true", count: "100", sort: "name:asc" });
    const response = await providerJson<{ collection?: CalendlyEventType[] }>(
      `https://api.calendly.com/event_types?${query.toString()}`,
      { headers: this.headers() },
      this.fetcher,
    );
    const active = (response.collection ?? []).filter((item) => item.active !== false && item.uri);
    if (!active.length) throw new Error("No active Calendly event types are available for the connected user.");

    let selected: CalendlyEventType | undefined;
    if (configured) {
      const target = normalized(configured);
      selected = active.find((item) => {
        const schedulingSlug = item.scheduling_url?.split("/").filter(Boolean).pop();
        const uriId = item.uri?.split("/").filter(Boolean).pop();
        return [item.name, item.slug, schedulingSlug, item.uri, uriId].some((value) => normalized(value) === target);
      });
      if (!selected) throw new Error(`No active Calendly event type matched "${configured}".`);
    } else if (active.length === 1) {
      selected = active[0];
    } else {
      throw new Error("Choose a Calendly event type before using calendar booking.");
    }

    if (!selected?.uri || !Number.isSafeInteger(selected.duration) ||
      !selected.duration || selected.duration < 1 || selected.duration > 720) {
      throw new Error("Calendly event type could not be resolved with a valid duration.");
    }
    this.resolvedEventType = { uri: selected.uri, duration: selected.duration };
    return this.resolvedEventType;
  }

  private async createInvitee(input: { eventType: string; startsAt: Date; timezone: string; attendeeName?: string; attendeeEmail: string }) {
    const response = await providerJson<CalendlyCreateInviteeResponse>("https://api.calendly.com/invitees", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        event_type: input.eventType,
        start_time: input.startsAt.toISOString(),
        invitee: {
          email: input.attendeeEmail,
          ...(input.attendeeName ? { name: input.attendeeName } : {}),
          timezone: input.timezone,
        },
      }),
    }, this.fetcher);
    const externalId = scheduledEventIdFromInvitee(response);
    if (!externalId) throw new Error("Calendly did not return a scheduled event ID.");
    return externalId;
  }

  private async cancelEvent(externalId: string, reason: string) {
    await providerJson<unknown>(`https://api.calendly.com/scheduled_events/${encodeURIComponent(externalId)}/cancellation`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ reason }),
    }, this.fetcher);
  }

  async getAvailability(input: { startsAt: Date; endsAt: Date; timezone: string; durationMinutes?: number }) {
    const eventType = await this.eventType();
    if (input.durationMinutes !== undefined && input.durationMinutes !== eventType.duration) {
      throw new Error("Calendly event type duration does not match the requested service duration.");
    }
    const query = new URLSearchParams({
      event_type: eventType.uri,
      start_time: input.startsAt.toISOString(),
      end_time: input.endsAt.toISOString(),
    });
    const response = await providerJson<{ collection?: Array<{ status?: string; start_time?: string }> }>(
      `https://api.calendly.com/event_type_available_times?${query.toString()}`,
      { headers: this.headers() },
      this.fetcher,
    );
    const durationMs = eventType.duration * 60_000;
    return (response.collection ?? [])
      .filter((slot) => slot.status === "available" && slot.start_time)
      .map((slot) => {
        const startsAt = new Date(slot.start_time!);
        if (!Number.isFinite(startsAt.getTime())) {
          throw new Error("Calendly returned an invalid available start time.");
        }
        return { startsAt, endsAt: new Date(startsAt.getTime() + durationMs) };
      });
  }

  async book(input: { startsAt: Date; endsAt: Date; timezone: string; title: string; attendeeName?: string; attendeeEmail?: string }) {
    if (!input.attendeeEmail) throw new Error("Calendly requires an attendee email address to create a booking.");
    const eventType = await this.eventType();
    const requestedDuration = (input.endsAt.getTime() - input.startsAt.getTime()) / 60_000;
    if (!Number.isSafeInteger(requestedDuration) || requestedDuration !== eventType.duration) {
      throw new Error("Calendly event type duration does not match the requested booking.");
    }
    const externalId = await this.createInvitee({
      eventType: eventType.uri,
      startsAt: input.startsAt,
      timezone: input.timezone,
      attendeeName: input.attendeeName,
      attendeeEmail: input.attendeeEmail,
    });
    const event = await providerJson<{ resource?: {
      uri?: string; status?: string; start_time?: string; end_time?: string;
    } }>(
      `https://api.calendly.com/scheduled_events/${encodeURIComponent(externalId)}`,
      { headers: this.headers() },
      this.fetcher,
    );
    if (!event.resource?.start_time || !event.resource.end_time ||
      event.resource.status === "canceled") {
      throw new Error("Calendly did not return a complete confirmed scheduled event.");
    }
    const startsAt = new Date(event.resource.start_time);
    const endsAt = new Date(event.resource.end_time);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) ||
      endsAt <= startsAt) {
      throw new Error("Calendly returned invalid confirmed scheduled event times.");
    }
    return { externalId, startsAt, endsAt };
  }

  async reschedule(input: { externalId: string; startsAt: Date; endsAt: Date; timezone: string }) {
    const event = await providerJson<{ resource?: { event_type?: string } }>(
      `https://api.calendly.com/scheduled_events/${encodeURIComponent(input.externalId)}`,
      { headers: this.headers() },
      this.fetcher,
    );
    const eventType = event.resource?.event_type;
    if (!eventType) throw new Error("Calendly did not return the original event type for rescheduling.");

    const invitees = await providerJson<{ collection?: CalendlyInvitee[] }>(
      `https://api.calendly.com/scheduled_events/${encodeURIComponent(input.externalId)}/invitees?status=active&count=1`,
      { headers: this.headers() },
      this.fetcher,
    );
    const invitee = invitees.collection?.find((item) => item.status !== "canceled") ?? invitees.collection?.[0];
    if (!invitee?.email) throw new Error("Calendly did not return an active invitee for rescheduling.");

    const replacementId = await this.createInvitee({
      eventType,
      startsAt: input.startsAt,
      timezone: invitee.timezone || input.timezone,
      attendeeName: invitee.name,
      attendeeEmail: invitee.email,
    });

    try {
      await this.cancelEvent(input.externalId, "Rescheduled through AI Caller");
    } catch (error) {
      try {
        await this.cancelEvent(replacementId, "Rollback after incomplete AI Caller reschedule");
      } catch {
        // Preserve the original failure; cleanup failure is secondary and the caller must surface the error.
      }
      throw error;
    }

    return { externalId: replacementId, startsAt: input.startsAt, endsAt: input.endsAt };
  }

  async cancel(input: { externalId: string }) {
    await this.cancelEvent(input.externalId, "Cancelled through AI Caller");
  }
}

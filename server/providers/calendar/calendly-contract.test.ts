import { describe, expect, it } from "vitest";
import { encryptIntegrationCredentials } from "@/server/security/secrets";
import { CalendlyCalendarProvider } from "./calendly";

function provider(fetcher: typeof fetch, eventType?: string) {
  return new CalendlyCalendarProvider({
    provider: "calendly",
    encryptedCredentials: encryptIntegrationCredentials({ token: "calendly-test" }) as unknown as Record<string, unknown>,
    settings: eventType ? { eventType } : {},
    runtimeSettings: {},
  }, fetcher);
}

const window = {
  startsAt: new Date("2030-09-23T10:00:00.000Z"),
  endsAt: new Date("2030-09-23T11:00:00.000Z"),
  timezone: "UTC",
  durationMinutes: 30,
};

describe("Calendly booking contracts fail closed", () => {
  it("requires an explicit event type when the account exposes multiple active choices", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return Response.json({ resource: { uri: "https://api.calendly.com/users/U1" } });
      }
      if (url.includes("/event_types?")) {
        return Response.json({ collection: [
          { active: true, name: "Consultation", slug: "consultation",
            uri: "https://api.calendly.com/event_types/E1", duration: 30 },
          { active: true, name: "Cleaning", slug: "cleaning",
            uri: "https://api.calendly.com/event_types/E2", duration: 240 },
        ] });
      }
      throw new Error("Unexpected request: " + url);
    }) as typeof fetch;

    await expect(provider(fetcher).getAvailability(window))
      .rejects.toThrow(/Choose a Calendly event type/);
  });

  it("rejects an application duration that differs from the configured event type", async () => {
    let availabilityCalls = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return Response.json({ resource: { uri: "https://api.calendly.com/users/U1" } });
      }
      if (url.includes("/event_types?")) {
        return Response.json({ collection: [{
          active: true, name: "Office Cleaning", slug: "office-cleaning",
          uri: "https://api.calendly.com/event_types/E1", duration: 30,
        }] });
      }
      if (url.includes("/event_type_available_times")) {
        availabilityCalls++;
        return Response.json({ collection: [] });
      }
      throw new Error("Unexpected request: " + url);
    }) as typeof fetch;

    await expect(provider(fetcher, "office-cleaning").getAvailability({
      ...window, durationMinutes: 240,
    })).rejects.toThrow(/duration does not match/);
    expect(availabilityCalls).toBe(0);
  });

  it("reads the confirmed scheduled event instead of manufacturing booking times", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push((init?.method ?? "GET") + " " + url);
      if (url.endsWith("/users/me")) {
        return Response.json({ resource: { uri: "https://api.calendly.com/users/U1" } });
      }
      if (url.includes("/event_types?")) {
        return Response.json({ collection: [{
          active: true, name: "Consultation", slug: "consultation",
          uri: "https://api.calendly.com/event_types/E1", duration: 30,
        }] });
      }
      if (url === "https://api.calendly.com/invitees") {
        return Response.json({ resource: {
          event: "https://api.calendly.com/scheduled_events/S1",
          uri: "https://api.calendly.com/scheduled_events/S1/invitees/I1",
        } }, { status: 201 });
      }
      if (url.endsWith("/scheduled_events/S1")) {
        return Response.json({ resource: {
          uri: "https://api.calendly.com/scheduled_events/S1",
          status: "active",
          start_time: "2030-09-23T10:00:00.000Z",
          end_time: "2030-09-23T10:30:00.000Z",
        } });
      }
      throw new Error("Unexpected request: " + url);
    }) as typeof fetch;

    const booked = await provider(fetcher, "consultation").book({
      startsAt: new Date("2030-09-23T10:00:00.000Z"),
      endsAt: new Date("2030-09-23T10:30:00.000Z"),
      timezone: "UTC", title: "Consultation", attendeeName: "Ada",
      attendeeEmail: "ada@example.com",
    });
    expect(booked).toEqual({
      externalId: "S1",
      startsAt: new Date("2030-09-23T10:00:00.000Z"),
      endsAt: new Date("2030-09-23T10:30:00.000Z"),
    });
    expect(seen.some((request) => request.includes("/scheduled_events/S1"))).toBe(true);
  });

  it("rejects a create response that cannot be verified as a complete scheduled event", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return Response.json({ resource: { uri: "https://api.calendly.com/users/U1" } });
      }
      if (url.includes("/event_types?")) {
        return Response.json({ collection: [{
          active: true, name: "Consultation", slug: "consultation",
          uri: "https://api.calendly.com/event_types/E1", duration: 30,
        }] });
      }
      if (url === "https://api.calendly.com/invitees") {
        return Response.json({ resource: {
          event: "https://api.calendly.com/scheduled_events/S1",
        } }, { status: 201 });
      }
      if (url.endsWith("/scheduled_events/S1")) {
        return Response.json({ resource: {
          status: "active", start_time: "2030-09-23T10:00:00.000Z",
        } });
      }
      throw new Error("Unexpected request: " + url);
    }) as typeof fetch;

    await expect(provider(fetcher, "consultation").book({
      startsAt: new Date("2030-09-23T10:00:00.000Z"),
      endsAt: new Date("2030-09-23T10:30:00.000Z"),
      timezone: "UTC", title: "Consultation", attendeeEmail: "ada@example.com",
    })).rejects.toThrow(/complete confirmed scheduled event/);
  });
});

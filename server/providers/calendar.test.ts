import { describe, expect, it } from "vitest";
import { encryptIntegrationCredentials } from "@/server/security/secrets";
import { createCalendarProvider, slotize } from "./calendar";

function calendlyProvider(fetcher: typeof fetch) {
  return createCalendarProvider({
    provider: "calendly",
    encryptedCredentials: encryptIntegrationCredentials({ token: "calendly-test-token" }) as unknown as Record<string, unknown>,
    settings: { eventTypeUri: "https://api.calendly.com/event_types/TYPE1" },
    runtimeSettings: {},
  }, fetcher);
}

describe("calendar availability slotting", () => {
  it("removes provider busy windows and keeps fixed booking slots", () => {
    const startsAt = new Date("2026-09-17T09:00:00.000Z");
    const endsAt = new Date("2026-09-17T12:00:00.000Z");
    const result = slotize(startsAt, endsAt, [
      { startsAt: new Date("2026-09-17T10:00:00.000Z"), endsAt: new Date("2026-09-17T10:30:00.000Z") },
    ], 30);

    expect(result.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-09-17T09:00:00.000Z",
      "2026-09-17T09:30:00.000Z",
      "2026-09-17T10:30:00.000Z",
      "2026-09-17T11:00:00.000Z",
      "2026-09-17T11:30:00.000Z",
    ]);
  });

  it("excludes slots that only partially overlap a busy window", () => {
    const result = slotize(
      new Date("2026-09-17T09:00:00.000Z"),
      new Date("2026-09-17T10:00:00.000Z"),
      [{ startsAt: new Date("2026-09-17T09:20:00.000Z"), endsAt: new Date("2026-09-17T09:40:00.000Z") }],
      30,
    );

    expect(result).toEqual([]);
  });
});

describe("Calendly normalized rescheduling", () => {
  it("creates the replacement booking before cancelling the original", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

      if (url.endsWith("/scheduled_events/original")) {
        return new Response(JSON.stringify({ resource: { event_type: "https://api.calendly.com/event_types/TYPE1" } }), { status: 200 });
      }
      if (url.includes("/scheduled_events/original/invitees")) {
        return new Response(JSON.stringify({ collection: [{ email: "lead@example.com", name: "Lead", timezone: "America/New_York", status: "active" }] }), { status: 200 });
      }
      if (url.endsWith("/invitees") && method === "POST") {
        return new Response(JSON.stringify({ resource: { event: "https://api.calendly.com/scheduled_events/replacement" } }), { status: 200 });
      }
      if (url.endsWith("/scheduled_events/original/cancellation") && method === "POST") {
        return new Response(JSON.stringify({ resource: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
    }) as typeof fetch;

    const provider = calendlyProvider(fetcher);
    const startsAt = new Date("2026-09-18T14:00:00.000Z");
    const endsAt = new Date("2026-09-18T14:30:00.000Z");
    const result = await provider.reschedule({ externalId: "original", startsAt, endsAt, timezone: "America/New_York" });

    expect(result).toEqual({ externalId: "replacement", startsAt, endsAt });
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "https://api.calendly.com/scheduled_events/original", method: "GET" },
      { url: "https://api.calendly.com/scheduled_events/original/invitees?status=active&count=1", method: "GET" },
      { url: "https://api.calendly.com/invitees", method: "POST" },
      { url: "https://api.calendly.com/scheduled_events/original/cancellation", method: "POST" },
    ]);
    expect(JSON.parse(calls[2].body ?? "{}")).toMatchObject({
      event_type: "https://api.calendly.com/event_types/TYPE1",
      start_time: startsAt.toISOString(),
      invitee: { email: "lead@example.com", name: "Lead", timezone: "America/New_York" },
    });
  });

  it("rolls back the replacement if cancelling the original fails", async () => {
    const cancellations: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/scheduled_events/original")) {
        return new Response(JSON.stringify({ resource: { event_type: "https://api.calendly.com/event_types/TYPE1" } }), { status: 200 });
      }
      if (url.includes("/scheduled_events/original/invitees")) {
        return new Response(JSON.stringify({ collection: [{ email: "lead@example.com", status: "active" }] }), { status: 200 });
      }
      if (url.endsWith("/invitees") && method === "POST") {
        return new Response(JSON.stringify({ resource: { event: "https://api.calendly.com/scheduled_events/replacement" } }), { status: 200 });
      }
      if (url.includes("/cancellation") && method === "POST") {
        cancellations.push(url);
        if (url.includes("/original/")) return new Response(JSON.stringify({ message: "cancel failed" }), { status: 500 });
        return new Response(JSON.stringify({ resource: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
    }) as typeof fetch;

    const provider = calendlyProvider(fetcher);
    await expect(provider.reschedule({
      externalId: "original",
      startsAt: new Date("2026-09-18T14:00:00.000Z"),
      endsAt: new Date("2026-09-18T14:30:00.000Z"),
      timezone: "UTC",
    })).rejects.toThrow("cancel failed");

    expect(cancellations).toEqual([
      "https://api.calendly.com/scheduled_events/original/cancellation",
      "https://api.calendly.com/scheduled_events/replacement/cancellation",
    ]);
  });
});

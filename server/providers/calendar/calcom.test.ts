import { describe, expect, it } from "vitest";
import { encryptIntegrationCredentials } from "@/server/security/secrets";
import { createCalendarProvider } from "./index";

function provider(fetcher: typeof fetch) {
  return createCalendarProvider({
    provider: "calcom",
    encryptedCredentials: encryptIntegrationCredentials({ apiKey: "cal-test-key" }) as unknown as Record<string, unknown>,
    settings: { slug: "owner-name" },
    runtimeSettings: { eventType: "consultation", meetingDurationMinutes: 30 },
  }, fetcher);
}

describe("Cal.com current API contracts", () => {
  it("uses the current slots query names, range response, and slot API version", async () => {
    let requestedUrl = "";
    let version = "";
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      version = new Headers(init?.headers).get("cal-api-version") ?? "";
      return new Response(JSON.stringify({
        status: "success",
        data: {
          "2026-09-20": [{ start: "2026-09-20T14:00:00.000Z", end: "2026-09-20T14:30:00.000Z" }],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await provider(fetcher).getAvailability({
      startsAt: new Date("2026-09-20T13:00:00.000Z"),
      endsAt: new Date("2026-09-20T16:00:00.000Z"),
      timezone: "America/New_York",
      durationMinutes: 30,
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/v2/slots");
    expect(url.searchParams.get("username")).toBe("owner-name");
    expect(url.searchParams.get("eventTypeSlug")).toBe("consultation");
    expect(url.searchParams.get("start")).toBe("2026-09-20T13:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-09-20T16:00:00.000Z");
    expect(url.searchParams.get("startTime")).toBeNull();
    expect(url.searchParams.get("eventSlug")).toBeNull();
    expect(url.searchParams.get("format")).toBe("range");
    expect(version).toBe("2024-09-04");
    expect(result).toEqual([{ startsAt: new Date("2026-09-20T14:00:00.000Z"), endsAt: new Date("2026-09-20T14:30:00.000Z") }]);
  });

  it("uses the current bookings API version and reschedulingReason field", async () => {
    let version = "";
    let body: Record<string, unknown> = {};
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      version = new Headers(init?.headers).get("cal-api-version") ?? "";
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: "success",
        data: { uid: "replacement", start: "2026-09-20T15:00:00.000Z", end: "2026-09-20T15:30:00.000Z" },
      }), { status: 201 });
    }) as typeof fetch;

    const result = await provider(fetcher).reschedule({
      externalId: "original",
      startsAt: new Date("2026-09-20T15:00:00.000Z"),
      endsAt: new Date("2026-09-20T15:30:00.000Z"),
      timezone: "UTC",
    });

    expect(version).toBe("2026-02-25");
    expect(body).toMatchObject({
      start: "2026-09-20T15:00:00.000Z",
      reschedulingReason: "Rescheduled through AI Caller",
    });
    expect(body).not.toHaveProperty("rescheduleReason");
    expect(result.externalId).toBe("replacement");
  });
});

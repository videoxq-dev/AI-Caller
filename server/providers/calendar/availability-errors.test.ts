import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { encryptIntegrationCredentials } from "@/server/security/secrets";
import { GoogleCalendarProvider } from "./google";
import { OutlookCalendarProvider } from "./outlook";

const window = {
  startsAt: new Date("2030-09-23T09:00:00.000Z"),
  endsAt: new Date("2030-09-23T10:00:00.000Z"),
  timezone: "UTC",
  durationMinutes: 30,
};

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "test-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "test-secret");
  resetEnvForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

function credentials(provider: "google" | "outlook") {
  return {
    provider,
    settings: { calendar: "primary" },
    encryptedCredentials: encryptIntegrationCredentials({ refreshToken: "test-refresh" }) as unknown as Record<string, unknown>,
  };
}

function google(response: unknown) {
  let freeBusyCalls = 0;
  const fetcher = (async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "test-access" });
    }
    if (url.endsWith("/freeBusy")) {
      freeBusyCalls++;
      return Response.json(response);
    }
    throw new Error("Unexpected test request");
  }) as typeof fetch;
  return { provider: new GoogleCalendarProvider(credentials("google"), fetcher),
    count: () => freeBusyCalls };
}

describe("Google availability fails closed", () => {
  it("distinguishes an empty calendar from missing calendar data", async () => {
    const clear = google({ calendars: { primary: { busy: [] } } });
    expect(await clear.provider.getAvailability(window)).toHaveLength(2);
    expect(clear.count()).toBe(1);
    const missing = google({ calendars: {} });
    await expect(missing.provider.getAvailability(window)).rejects.toThrow(/complete successful free\/busy/);
  });

  it("does not interpret an individual calendar error as all slots free", async () => {
    const failure = google({ calendars: {
      primary: { busy: [], errors: [{ reason: "notFound", domain: "calendar" }] },
    } });
    await expect(failure.provider.getAvailability(window)).rejects.toThrow(/complete successful free\/busy/);
  });

  it("rejects invalid busy entries rather than treating fallback timestamps as availability", async () => {
    const malformed = google({ calendars: { primary: { busy: [
      { start: "invalid", end: "2030-09-23T09:30:00Z" },
    ] } } });
    await expect(malformed.provider.getAvailability(window)).rejects.toThrow(/invalid busy interval/);
  });
});

describe("Outlook availability consumes all pages", () => {
  it("does not advertise a free slot occupied on a subsequent provider page", async () => {
    const visited: string[] = [];
    const fetcher = (async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "test-access" });
      visited.push(url);
      if (!url.includes("page=2")) {
        return Response.json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page=2" });
      }
      return Response.json({ value: [{
        isCancelled: false, showAs: "busy",
        start: { dateTime: "2030-09-23T09:30:00" },
        end: { dateTime: "2030-09-23T10:00:00" },
      }] });
    }) as typeof fetch;
    const provider = new OutlookCalendarProvider(credentials("outlook"), fetcher);
    expect(await provider.getAvailability(window)).toEqual([{
      startsAt: new Date("2030-09-23T09:00:00.000Z"),
      endsAt: new Date("2030-09-23T09:30:00.000Z"),
    }]);
    expect(visited).toHaveLength(2);
  });

  it("rejects missing pages, invalid links and malformed busy ranges", async () => {
    for (const response of [
      {},
      { value: [], "@odata.nextLink": "https://example.invalid/steal" },
      { value: [{ start: {}, end: {} }] },
    ]) {
      const fetcher = (async (request: RequestInfo | URL) => String(request).includes("login.microsoftonline.com")
        ? Response.json({ access_token: "test-access" })
        : Response.json(response)) as typeof fetch;
      await expect(new OutlookCalendarProvider(credentials("outlook"), fetcher).getAvailability(window))
        .rejects.toThrow();
    }
  });
});

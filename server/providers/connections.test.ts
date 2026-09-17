import { describe, expect, it, vi } from "vitest";
import { encryptIntegrationCredentials } from "@/server/security/secrets";
import { resetEnvForTests } from "@/server/env";
import { testProviderConnection } from "./connections";

describe("provider connection testing", () => {
  it("sends Gemini API credentials in a header instead of the request URL", async () => {
    const apiKey = "gemini-secret-key";
    let requestedUrl = "";
    let sentApiKey: string | null = null;

    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      sentApiKey = new Headers(init?.headers).get("x-goog-api-key");
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as typeof fetch;

    await expect(testProviderConnection({
      provider: "gemini",
      encryptedCredentials: encryptIntegrationCredentials({ apiKey }) as unknown as Record<string, unknown>,
      settings: {},
    }, fetcher)).resolves.toEqual({ ok: true });

    expect(requestedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(requestedUrl).not.toContain(apiKey);
    expect(sentApiKey).toBe(apiKey);
  });

  it("tests Outlook against Microsoft Graph's default calendar endpoint", async () => {
    vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "test-client-id");
    vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "test-client-secret");
    resetEnvForTests();

    const urls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 });
      }
      if (url === "https://graph.microsoft.com/v1.0/me/calendar") {
        return new Response(JSON.stringify({ id: "default-calendar-id", name: "Default Calendar" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected request" } }), { status: 500 });
    }) as typeof fetch;

    try {
      await expect(testProviderConnection({
        provider: "outlook",
        encryptedCredentials: encryptIntegrationCredentials({ refreshToken: "refresh-token" }) as unknown as Record<string, unknown>,
        settings: {},
      }, fetcher)).resolves.toEqual({
        ok: true,
        metadata: { calendarId: "default-calendar-id", calendarName: "Default Calendar" },
      });

      expect(urls).toContain("https://graph.microsoft.com/v1.0/me/calendar");
      expect(urls.some((url) => url.includes("/me/calendars"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      resetEnvForTests();
    }
  });
});

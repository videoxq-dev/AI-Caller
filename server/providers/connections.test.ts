import { describe, expect, it } from "vitest";
import { encryptIntegrationCredentials } from "@/server/security/secrets";
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
});

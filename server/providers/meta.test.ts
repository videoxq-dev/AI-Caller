import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { completeMetaEmbeddedSignup } from "./meta";

const keys = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_EMBEDDED_SIGNUP_CONFIG_ID",
  "META_GRAPH_API_VERSION",
  "META_PHONE_REGISTRATION_PIN",
] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.META_APP_ID = "meta-app-id";
  process.env.META_APP_SECRET = "meta-app-secret";
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = "embedded-config";
  process.env.META_GRAPH_API_VERSION = "v22.0";
  process.env.META_PHONE_REGISTRATION_PIN = "123456";
  resetEnvForTests();
});

afterEach(() => {
  for (const key of keys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvForTests();
});

describe("Meta Embedded Signup", () => {
  it("exchanges the code, validates assets, registers the phone, and subscribes webhooks", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
      calls.push({ url, method, authorization: headers.get("authorization"), body });

      if (url.endsWith("/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "customer-meta-access-token" }), { status: 200 });
      }
      if (url.includes("/phone-123?fields=")) {
        return new Response(JSON.stringify({ display_phone_number: "+15551234567", verified_name: "Acme" }), { status: 200 });
      }
      if (url.includes("/waba-456?fields=")) {
        return new Response(JSON.stringify({ id: "waba-456", name: "Acme WABA", currency: "USD" }), { status: 200 });
      }
      if (url.endsWith("/phone-123/register")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.endsWith("/waba-456/subscribed_apps")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected request" } }), { status: 500 });
    }) as typeof fetch;

    const result = await completeMetaEmbeddedSignup({
      code: "embedded-code",
      wabaId: "waba-456",
      phoneNumberId: "phone-123",
      businessId: "business-789",
    }, fetcher);

    expect(result.credentials).toEqual({
      accessToken: "customer-meta-access-token",
      wabaId: "waba-456",
      phoneNumberId: "phone-123",
      businessId: "business-789",
    });
    expect(result.settings).toMatchObject({
      authMethod: "EMBEDDED_SIGNUP",
      displayPhoneNumber: "+15551234567",
      verifiedName: "Acme",
      wabaName: "Acme WABA",
      webhookSubscribed: true,
    });
    expect(calls.map((call) => [new URL(call.url).pathname, call.method])).toEqual([
      ["/v22.0/oauth/access_token", "POST"],
      ["/v22.0/phone-123", "GET"],
      ["/v22.0/waba-456", "GET"],
      ["/v22.0/phone-123/register", "POST"],
      ["/v22.0/waba-456/subscribed_apps", "POST"],
    ]);
    expect(calls[0].body).toContain("client_id=meta-app-id");
    expect(calls[0].body).toContain("client_secret=meta-app-secret");
    expect(calls.slice(1).every((call) => call.authorization === "Bearer customer-meta-access-token")).toBe(true);
    expect(JSON.parse(calls[3].body)).toEqual({ messaging_product: "whatsapp", pin: "123456" });
    expect(JSON.stringify(result.settings)).not.toContain("customer-meta-access-token");
  });
});

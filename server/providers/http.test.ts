import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError, providerJson } from "./http";

describe("carrier HTTP error metadata", () => {
  it("preserves validated Telnyx code and source pointer without logging provider detail", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      errors: [{
        code: "10002",
        title: "Invalid parameter",
        detail: "Bearer secret-token was rejected for +15551234567",
        source: { pointer: "/messaging_profile_id" },
      }],
    }), { status: 400 })) as typeof fetch;
    const error = await providerJson("/fake", {}, fetcher).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({
      status: 400,
      providerCode: "10002",
      providerField: "/messaging_profile_id",
      message: "Provider returned HTTP 400.",
    });
    expect(JSON.stringify(error)).not.toContain("secret-token");
  });

  it("drops unsafe carrier metadata that could contain credentials or PII", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      errors: [{
        code: "secret token +15551234567",
        detail: "Do not forward this raw response.",
        source: { pointer: "/body/password/abc@secret" },
      }],
    }), { status: 400 })) as typeof fetch;
    const error = await providerJson("/fake", {}, fetcher).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({ status: 400, message: "Provider returned HTTP 400." });
    if (!(error instanceof ProviderRequestError)) throw new Error("Expected ProviderRequestError");
    expect(error.providerCode).toBeUndefined();
    expect(error.providerField).toBeUndefined();
  });
});

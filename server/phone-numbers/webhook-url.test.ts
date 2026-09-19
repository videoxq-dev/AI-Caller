import { describe, expect, it } from "vitest";
import { managedNumberWebhookUrls, resolveManagedWebhookBaseUrl } from "./webhook-url";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("Telnyx managed webhook URL validation", () => {
  it("keeps local sign-in independent of public Telnyx callbacks", () => {
    const urls = managedNumberWebhookUrls(workspaceId, {
      BETTER_AUTH_URL: "http://localhost:3000",
      HOSTED_WEBHOOK_BASE_URL: "https://testing-tunnel.ngrok-free.app/",
    });
    expect(urls.voice).toBe(
      `https://testing-tunnel.ngrok-free.app/api/webhooks/voice/telnyx/${workspaceId}`,
    );
    expect(urls.sms).toBe(
      `https://testing-tunnel.ngrok-free.app/api/webhooks/sms/telnyx/${workspaceId}`,
    );
  });

  it("uses the public auth URL when a separate tunnel is unnecessary", () => {
    expect(resolveManagedWebhookBaseUrl("https://app.acme-business.com/"))
      .toBe("https://app.acme-business.com");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://192.168.0.10:3000",
    "https://localhost:3000",
    "https://[::1]:3000",
    "https://local.internal",
    "https://myapp.local",
    "https://example.com",
    "https://myapp.example.com",
    "http://app.acme-business.com",
    "ftp://app.acme-business.com",
    "https://user:password@app.acme-business.com",
    "https://app.acme-business.com/incorrect-path",
    "https://app.acme-business.com/?token=secret",
    "https://app.acme-business.com/#fragment",
    "invalid-url",
  ])("rejects unreachable or unsafe callback origin %s", (candidate) => {
    expect(() => resolveManagedWebhookBaseUrl(candidate)).toThrow(
      expect.objectContaining({ code: "PUBLIC_WEBHOOK_URL_REQUIRED", status: 422 }),
    );
  });

  it("rejects a bad override instead of silently falling back to the auth URL", () => {
    expect(() => resolveManagedWebhookBaseUrl("https://app.acme-business.com", "http://localhost:3000"))
      .toThrow(expect.objectContaining({ code: "PUBLIC_WEBHOOK_URL_REQUIRED" }));
  });

  it("allows local HTTP only for explicitly guarded CI fixture calls", () => {
    const result = managedNumberWebhookUrls(workspaceId, {
      BETTER_AUTH_URL: "http://localhost:3000",
    }, true);
    expect(result.voice).toBe(`http://localhost:3000/api/webhooks/voice/telnyx/${workspaceId}`);
    expect(() => resolveManagedWebhookBaseUrl("ftp://localhost", undefined, true))
      .toThrow(expect.objectContaining({ code: "PUBLIC_WEBHOOK_URL_REQUIRED" }));
  });
});

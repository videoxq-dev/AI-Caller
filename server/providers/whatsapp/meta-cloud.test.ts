import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMetaWhatsAppProvider } from "./meta-cloud";

const payload = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{
    id: "waba-1",
    changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: "phone-id-1" },
        contacts: [{ profile: { name: "Ada" }, wa_id: "15551234567" }],
        messages: [{ id: "wamid.inbound", from: "15551234567", timestamp: "1789675200", type: "text", text: { body: "Book a visit" } }],
        statuses: [{ id: "wamid.outbound", status: "delivered", timestamp: "1789675260" }],
      },
    }],
  }],
});

function requestWithSignature(secret: string, body: string) {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://example.test/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
}

describe("Meta WhatsApp Cloud adapter", () => {
  it("verifies the raw-body signature and normalizes inbound plus delivery events", async () => {
    const provider = createMetaWhatsAppProvider(
      { accessToken: "token" },
      { appSecret: "app-secret", graphApiVersion: "v22.0" },
    );
    const request = requestWithSignature("app-secret", payload);

    await expect(provider.verifyWebhook({ request, rawBody: payload })).resolves.toBe(true);
    const events = await provider.normalizeWebhook({ request, rawBody: payload });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "MESSAGE_RECEIVED",
      externalMessageId: "wamid.inbound",
      phoneNumberId: "phone-id-1",
      from: "15551234567",
      profileName: "Ada",
      text: "Book a visit",
    });
    expect(events[1]).toMatchObject({
      type: "DELIVERY_UPDATED",
      externalMessageId: "wamid.outbound",
      status: "DELIVERED",
    });
  });

  it("rejects an invalid signature", async () => {
    const provider = createMetaWhatsAppProvider(
      { accessToken: "token" },
      { appSecret: "app-secret", graphApiVersion: "v22.0" },
    );
    const request = new Request("https://example.test/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body: payload,
    });
    await expect(provider.verifyWebhook({ request, rawBody: payload })).resolves.toBe(false);
  });

  it("sends text and template messages through the Graph messages endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.sent" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = createMetaWhatsAppProvider(
      { accessToken: "token" },
      { appSecret: "app-secret", graphApiVersion: "v22.0" },
      fetcher as typeof fetch,
    );

    await expect(provider.sendText({ phoneNumberId: "phone-id", to: "15551234567", text: "Hello" })).resolves.toEqual({ externalId: "wamid.sent", status: "SENT" });
    await expect(provider.sendTemplate({ phoneNumberId: "phone-id", to: "15551234567", templateName: "appointment_reminder", languageCode: "en_US" })).resolves.toEqual({ externalId: "wamid.sent", status: "SENT" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v22.0/phone-id/messages");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      messaging_product: "whatsapp",
      type: "template",
      template: { name: "appointment_reminder", language: { code: "en_US" } },
    });
  });
});

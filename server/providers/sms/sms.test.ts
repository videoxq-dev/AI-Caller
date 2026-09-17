import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPlivoSmsProvider } from "./plivo";
import { createTelnyxSmsProvider, parseTelnyxWebhookPublicKey } from "./telnyx";
import { createTwilioSmsProvider } from "./twilio";

function formRequest(url: string, rawBody: string, headers: Record<string, string>) {
  return {
    request: new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: rawBody }),
    rawBody,
    webhookUrl: url,
    contentType: "application/x-www-form-urlencoded",
  };
}

function twilioSignature(url: string, rawBody: string, token: string) {
  const pairs = Array.from(new URLSearchParams(rawBody).entries()).sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  return createHmac("sha1", token).update(`${url}${pairs.map(([key, value]) => `${key}${value}`).join("")}`, "utf8").digest("base64");
}

function plivoSignature(url: string, nonce: string, token: string) {
  return createHmac("sha256", token).update(`${url}${nonce}`, "utf8").digest("base64");
}

describe("SMS provider adapters", () => {
  it("verifies and normalizes Twilio inbound messages", async () => {
    const url = "https://app.example.com/api/webhooks/sms/twilio";
    const body = new URLSearchParams({ MessageSid: "SM123", From: "+12025550100", To: "+12025550200", Body: "Need an appointment", SmsStatus: "received" }).toString();
    const token = "twilio-secret";
    const provider = createTwilioSmsProvider({ accountSid: "AC123", authToken: token });
    const input = formRequest(url, body, { "x-twilio-signature": twilioSignature(url, body, token) });

    await expect(provider.verifyWebhook(input)).resolves.toBe(true);
    await expect(provider.normalizeWebhook(input)).resolves.toEqual([expect.objectContaining({
      type: "MESSAGE_RECEIVED",
      externalMessageId: "SM123",
      from: "+12025550100",
      to: "+12025550200",
      text: "Need an appointment",
    })]);
  });

  it("verifies and normalizes Plivo messaging callbacks with V2 signatures", async () => {
    const url = "https://app.example.com/api/webhooks/sms/plivo";
    const nonce = "nonce-123";
    const token = "plivo-secret";
    const body = new URLSearchParams({ MessageUUID: "uuid-123", Status: "delivered" }).toString();
    const provider = createPlivoSmsProvider({ authId: "MA123", authToken: token });
    const input = formRequest(url, body, {
      "x-plivo-signature-v2": plivoSignature(url, nonce, token),
      "x-plivo-signature-v2-nonce": nonce,
    });

    await expect(provider.verifyWebhook(input)).resolves.toBe(true);
    await expect(provider.normalizeWebhook(input)).resolves.toEqual([expect.objectContaining({
      type: "DELIVERY_UPDATED",
      externalMessageId: "uuid-123",
      status: "DELIVERED",
    })]);
  });

  it("verifies Telnyx Ed25519 signatures and normalizes inbound messages", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const rawPublicKey = Buffer.from(spki).subarray(-32).toString("base64");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ data: { id: "event-123", event_type: "message.received", occurred_at: new Date().toISOString(), payload: { id: "message-123", from: { phone_number: "+12025550100" }, to: [{ phone_number: "+12025550200" }], text: "Book me tomorrow" } } });
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`, "utf8"), privateKey).toString("base64");
    const url = "https://app.example.com/api/webhooks/sms/telnyx";
    const request = new Request(url, { method: "POST", headers: { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": signature }, body });
    const provider = createTelnyxSmsProvider({ apiKey: "KEY123", webhookPublicKey: rawPublicKey });
    const input = { request, rawBody: body, webhookUrl: url, contentType: "application/json" };

    await expect(provider.verifyWebhook(input)).resolves.toBe(true);
    await expect(provider.normalizeWebhook(input)).resolves.toEqual([expect.objectContaining({
      type: "MESSAGE_RECEIVED",
      externalEventId: "event-123",
      externalMessageId: "message-123",
      text: "Book me tomorrow",
    })]);
  });

  it("rejects non-Ed25519 PEM keys for Telnyx webhook verification", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(() => parseTelnyxWebhookPublicKey(pem)).toThrow("Ed25519 public key");
  });

  it("sends outbound messages through the normalized adapter contract", async () => {
    const fetcherMock = vi.fn(async () => new Response(JSON.stringify({ sid: "SM-outbound", status: "queued" }), { status: 201, headers: { "content-type": "application/json" } }));
    const provider = createTwilioSmsProvider({ accountSid: "AC123", authToken: "secret", fetcher: fetcherMock as unknown as typeof fetch });

    await expect(provider.send({ to: "+12025550100", from: "+12025550200", text: "Confirmed" })).resolves.toEqual({ externalId: "SM-outbound", status: "QUEUED" });
    expect(fetcherMock).toHaveBeenCalledTimes(1);
    const [, init] = fetcherMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("Body=Confirmed");
  });
});

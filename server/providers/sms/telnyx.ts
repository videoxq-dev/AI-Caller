import { providerJson } from "../http";
import { parseTelnyxWebhookPublicKey, verifyTelnyxWebhookSignature } from "../telnyx-webhook";
export { parseTelnyxWebhookPublicKey } from "../telnyx-webhook";
import type { NormalizedSmsEvent, SMSProvider, SmsWebhookInput } from "../contracts";
import { mapSmsDeliveryStatus, normalizeOccurredAt, requiredString } from "./common";

type TelnyxConfig = {
  apiKey: string;
  webhookPublicKey: string;
  fetcher?: typeof fetch;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createTelnyxSmsProvider(config: TelnyxConfig): SMSProvider {
  const fetcher = config.fetcher ?? fetch;
  const apiKey = requiredString(config.apiKey, "Telnyx API key");
  const publicKey = parseTelnyxWebhookPublicKey(config.webhookPublicKey);

  return {
    async send(input) {
      const response = await providerJson<{ data?: { id?: string; to?: Array<{ status?: string }> } }>(
        "https://api.telnyx.com/v2/messages",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: input.from,
            to: input.to,
            text: input.text,
            ...(input.statusCallbackUrl ? { webhook_url: input.statusCallbackUrl } : {}),
            use_profile_webhooks: !input.statusCallbackUrl,
          }),
        },
        fetcher,
      );
      const externalId = requiredString(response.data?.id, "Telnyx message id");
      return { externalId, status: mapSmsDeliveryStatus(response.data?.to?.[0]?.status) ?? "QUEUED" };
    },

    async verifyWebhook(input: SmsWebhookInput) {
      return verifyTelnyxWebhookSignature(input.request, input.rawBody, publicKey);
    },

    async normalizeWebhook(input: SmsWebhookInput): Promise<NormalizedSmsEvent[]> {
      let parsed: unknown;
      try { parsed = JSON.parse(input.rawBody); } catch { return []; }
      const root = asRecord(parsed);
      const data = asRecord(root?.data);
      const payload = asRecord(data?.payload);
      const eventType = typeof data?.event_type === "string" ? data.event_type : null;
      const externalEventId = typeof data?.id === "string" ? data.id : null;
      if (!eventType || !externalEventId || !payload) return [];

      const externalMessageId = typeof payload.id === "string" ? payload.id : null;
      if (!externalMessageId) return [];
      const occurredAt = normalizeOccurredAt(data?.occurred_at);

      if (eventType === "message.received") {
        const from = asRecord(payload.from);
        const toList = Array.isArray(payload.to) ? payload.to : [];
        const to = asRecord(toList[0]);
        const fromNumber = typeof from?.phone_number === "string" ? from.phone_number : null;
        const toNumber = typeof to?.phone_number === "string" ? to.phone_number : null;
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (!fromNumber || !toNumber || !text) return [];
        return [{ type: "MESSAGE_RECEIVED", externalEventId, externalMessageId, from: fromNumber, to: toNumber, text, occurredAt }];
      }

      if (eventType !== "message.sent" && eventType !== "message.finalized") return [];
      const toList = Array.isArray(payload.to) ? payload.to : [];
      const to = asRecord(toList[0]);
      const status = eventType === "message.sent" ? "SENT" : mapSmsDeliveryStatus(to?.status);
      if (!status) return [];
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const firstError = asRecord(errors[0]);
      const error = typeof firstError?.detail === "string" ? firstError.detail : typeof firstError?.title === "string" ? firstError.title : null;
      return [{ type: "DELIVERY_UPDATED", externalEventId, externalMessageId, status, error, occurredAt }];
    },
  };
}

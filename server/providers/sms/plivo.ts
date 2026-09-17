import { createHmac } from "node:crypto";
import { basicAuth, providerJson } from "../http";
import type { NormalizedSmsEvent, SMSProvider, SmsWebhookInput } from "../contracts";
import { constantTimeTextEqual, firstFormValue, mapSmsDeliveryStatus, parseFormBody, requiredString } from "./common";

type PlivoConfig = {
  authId: string;
  authToken: string;
  fetcher?: typeof fetch;
};

function plivoV3Signature(url: string, rawBody: string, nonce: string, authToken: string) {
  const form = parseFormBody(rawBody);
  const pairs = Array.from(form.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyCompare = leftKey.localeCompare(rightKey);
    return keyCompare === 0 ? leftValue.localeCompare(rightValue) : keyCompare;
  });
  const payload = `${url}${pairs.map(([key, value]) => `${key}${value}`).join("")}${nonce}`;
  return createHmac("sha256", authToken).update(payload, "utf8").digest("base64");
}

export function createPlivoSmsProvider(config: PlivoConfig): SMSProvider {
  const fetcher = config.fetcher ?? fetch;
  const authId = requiredString(config.authId, "Plivo Auth ID");
  const authToken = requiredString(config.authToken, "Plivo Auth Token");

  return {
    async send(input) {
      const response = await providerJson<{ message_uuid?: string[] }>(
        `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Message/`,
        {
          method: "POST",
          headers: {
            authorization: basicAuth(authId, authToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            src: input.from,
            dst: input.to,
            text: input.text,
            ...(input.statusCallbackUrl ? { url: input.statusCallbackUrl } : {}),
          }),
        },
        fetcher,
      );
      const externalId = requiredString(response.message_uuid?.[0], "Plivo message UUID");
      return { externalId, status: "QUEUED" };
    },

    async verifyWebhook(input: SmsWebhookInput) {
      const signatureHeader = input.request.headers.get("x-plivo-signature-v3");
      const nonce = input.request.headers.get("x-plivo-signature-v3-nonce");
      if (!signatureHeader || !nonce || !input.contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) return false;
      const expected = plivoV3Signature(input.webhookUrl, input.rawBody, nonce, authToken);
      return signatureHeader.split(",").some((signature) => constantTimeTextEqual(signature.trim(), expected));
    },

    async normalizeWebhook(input: SmsWebhookInput): Promise<NormalizedSmsEvent[]> {
      const form = parseFormBody(input.rawBody);
      const externalMessageId = firstFormValue(form, "MessageUUID") ?? firstFormValue(form, "MessageUuid");
      if (!externalMessageId) return [];

      const from = firstFormValue(form, "From");
      const to = firstFormValue(form, "To");
      const text = firstFormValue(form, "Text");
      const statusValue = firstFormValue(form, "Status") ?? firstFormValue(form, "MessageState");
      const deliveryStatus = mapSmsDeliveryStatus(statusValue);

      if (from && to && text && !deliveryStatus) {
        return [{
          type: "MESSAGE_RECEIVED",
          externalEventId: `${externalMessageId}:received`,
          externalMessageId,
          from,
          to,
          text,
          occurredAt: null,
        }];
      }

      if (!deliveryStatus) return [];
      const errorCode = firstFormValue(form, "ErrorCode");
      return [{
        type: "DELIVERY_UPDATED",
        externalEventId: `${externalMessageId}:${deliveryStatus.toLowerCase()}`,
        externalMessageId,
        status: deliveryStatus,
        error: errorCode,
        occurredAt: null,
      }];
    },
  };
}

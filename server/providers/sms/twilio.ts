import { createHmac } from "node:crypto";
import { basicAuth, providerJson } from "../http";
import type { NormalizedSmsEvent, SMSProvider, SmsWebhookInput } from "../contracts";
import { constantTimeTextEqual, firstFormValue, mapSmsDeliveryStatus, parseFormBody, requiredString } from "./common";

type TwilioConfig = {
  accountSid: string;
  authToken: string;
  fetcher?: typeof fetch;
};

function twilioSignature(url: string, rawBody: string, authToken: string) {
  const form = parseFormBody(rawBody);
  const pairs = Array.from(form.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyCompare = leftKey.localeCompare(rightKey);
    return keyCompare === 0 ? leftValue.localeCompare(rightValue) : keyCompare;
  });
  const payload = `${url}${pairs.map(([key, value]) => `${key}${value}`).join("")}`;
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

export function createTwilioSmsProvider(config: TwilioConfig): SMSProvider {
  const fetcher = config.fetcher ?? fetch;
  const accountSid = requiredString(config.accountSid, "Twilio Account SID");
  const authToken = requiredString(config.authToken, "Twilio Auth Token");

  return {
    async send(input) {
      const body = new URLSearchParams({ To: input.to, From: input.from, Body: input.text });
      if (input.statusCallbackUrl) body.set("StatusCallback", input.statusCallbackUrl);
      const response = await providerJson<{ sid?: string; status?: string }>(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: basicAuth(accountSid, authToken),
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
        fetcher,
      );
      const externalId = requiredString(response.sid, "Twilio message SID");
      return { externalId, status: mapSmsDeliveryStatus(response.status) ?? "QUEUED" };
    },

    async verifyWebhook(input: SmsWebhookInput) {
      const signature = input.request.headers.get("x-twilio-signature");
      if (!signature || !input.contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) return false;
      return constantTimeTextEqual(signature, twilioSignature(input.webhookUrl, input.rawBody, authToken));
    },

    async normalizeWebhook(input: SmsWebhookInput): Promise<NormalizedSmsEvent[]> {
      const form = parseFormBody(input.rawBody);
      const externalMessageId = firstFormValue(form, "MessageSid") ?? firstFormValue(form, "SmsSid");
      if (!externalMessageId) return [];

      const statusValue = firstFormValue(form, "MessageStatus") ?? firstFormValue(form, "SmsStatus");
      const deliveryStatus = mapSmsDeliveryStatus(statusValue);
      const from = firstFormValue(form, "From");
      const to = firstFormValue(form, "To");
      const body = firstFormValue(form, "Body");

      if (from && to && body && (!deliveryStatus || statusValue?.toLowerCase() === "received")) {
        return [{
          type: "MESSAGE_RECEIVED",
          externalEventId: `${externalMessageId}:received`,
          externalMessageId,
          from,
          to,
          text: body,
          occurredAt: null,
        }];
      }

      if (!deliveryStatus) return [];
      const errorCode = firstFormValue(form, "ErrorCode");
      const errorMessage = firstFormValue(form, "ErrorMessage");
      return [{
        type: "DELIVERY_UPDATED",
        externalEventId: `${externalMessageId}:${deliveryStatus.toLowerCase()}`,
        externalMessageId,
        status: deliveryStatus,
        error: errorMessage ?? errorCode,
        occurredAt: null,
      }];
    },
  };
}

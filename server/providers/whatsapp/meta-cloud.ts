import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv } from "@/server/env";
import { providerJson } from "@/server/providers/http";
import type {
  NormalizedWhatsAppEvent,
  WhatsAppProvider,
  WhatsAppWebhookInput,
} from "@/server/providers/contracts";

const webhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({
      field: z.literal("messages"),
      value: z.object({
        metadata: z.object({ phone_number_id: z.string() }),
        contacts: z.array(z.object({ profile: z.object({ name: z.string().optional() }).optional(), wa_id: z.string() })).optional(),
        messages: z.array(z.object({
          id: z.string(),
          from: z.string(),
          timestamp: z.string().optional(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
          button: z.object({ text: z.string() }).optional(),
          interactive: z.object({
            button_reply: z.object({ title: z.string() }).optional(),
            list_reply: z.object({ title: z.string() }).optional(),
          }).optional(),
        })).optional(),
        statuses: z.array(z.object({
          id: z.string(),
          status: z.enum(["sent", "delivered", "read", "failed"]),
          timestamp: z.string().optional(),
          errors: z.array(z.object({ title: z.string().optional(), message: z.string().optional() })).optional(),
        })).optional(),
      }).passthrough(),
    })),
  })),
});

function occurredAt(timestamp?: string) {
  if (!timestamp) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return null;
  const value = new Date(seconds * 1000);
  return Number.isNaN(value.getTime()) ? null : value;
}

function messageText(message: z.infer<typeof webhookSchema>["entry"][number]["changes"][number]["value"]["messages"] extends Array<infer T> ? T : never) {
  if (message.type === "text") return message.text?.body?.trim() || null;
  if (message.type === "button") return message.button?.text?.trim() || null;
  if (message.type === "interactive") return message.interactive?.button_reply?.title?.trim() || message.interactive?.list_reply?.title?.trim() || null;
  return null;
}

function deliveryStatus(status: "sent" | "delivered" | "read" | "failed") {
  return status.toUpperCase() as "SENT" | "DELIVERED" | "READ" | "FAILED";
}

export function createMetaWhatsAppProvider(
  credentials: { accessToken: string },
  options: { appSecret?: string; graphApiVersion?: string } = {},
  fetcher: typeof fetch = fetch,
): WhatsAppProvider {
  const env = getEnv();
  const appSecret = options.appSecret ?? env.META_APP_SECRET;
  const graphApiVersion = options.graphApiVersion ?? env.META_GRAPH_API_VERSION;
  if (!credentials.accessToken) throw new Error("Meta WhatsApp access token is required.");
  if (!appSecret) throw new Error("META_APP_SECRET is required to verify WhatsApp webhooks.");

  async function send(phoneNumberId: string, body: Record<string, unknown>) {
    const result = await providerJson<{ messages?: Array<{ id?: string }> }>(
      `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      },
      fetcher,
    );
    const externalId = result.messages?.[0]?.id;
    if (!externalId) throw new Error("Meta did not return a WhatsApp message ID.");
    return { externalId, status: "SENT" as const };
  }

  return {
    async sendText(input) {
      return send(input.phoneNumberId, {
        recipient_type: "individual",
        to: input.to,
        type: "text",
        text: { preview_url: false, body: input.text },
      });
    },

    async sendTemplate(input) {
      return send(input.phoneNumberId, {
        recipient_type: "individual",
        to: input.to,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: input.languageCode },
          ...(input.components?.length ? { components: input.components } : {}),
        },
      });
    },

    async verifyWebhook(input: WhatsAppWebhookInput) {
      const signature = input.request.headers.get("x-hub-signature-256");
      if (!signature?.startsWith("sha256=")) return false;
      const supplied = signature.slice(7);
      if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
      const expected = createHmac("sha256", appSecret).update(input.rawBody, "utf8").digest("hex");
      return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
    },

    async normalizeWebhook(input: WhatsAppWebhookInput) {
      let payload: unknown;
      try {
        payload = JSON.parse(input.rawBody);
      } catch {
        return [];
      }
      const parsed = webhookSchema.safeParse(payload);
      if (!parsed.success) return [];

      const events: NormalizedWhatsAppEvent[] = [];
      for (const entry of parsed.data.entry) {
        for (const change of entry.changes) {
          const value = change.value;
          const phoneNumberId = value.metadata.phone_number_id;
          const contactNames = new Map((value.contacts ?? []).map((contact) => [contact.wa_id, contact.profile?.name ?? null]));

          for (const message of value.messages ?? []) {
            const text = messageText(message);
            if (!text) continue;
            events.push({
              type: "MESSAGE_RECEIVED",
              externalEventId: message.id,
              externalMessageId: message.id,
              phoneNumberId,
              from: message.from,
              profileName: contactNames.get(message.from) ?? null,
              text,
              occurredAt: occurredAt(message.timestamp),
            });
          }

          for (const status of value.statuses ?? []) {
            const timestamp = status.timestamp ?? "unknown";
            const error = status.errors?.map((item) => item.message ?? item.title).filter(Boolean).join("; ") || null;
            events.push({
              type: "DELIVERY_UPDATED",
              externalEventId: `${status.id}:${status.status}:${timestamp}`,
              externalMessageId: status.id,
              phoneNumberId,
              status: deliveryStatus(status.status),
              error,
              occurredAt: occurredAt(status.timestamp),
            });
          }
        }
      }
      return events;
    },
  };
}

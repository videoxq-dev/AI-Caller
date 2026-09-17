export type Capability = "AI_TEXT" | "SMS" | "VOICE" | "WHATSAPP" | "CALENDAR";
export type ProviderMode = "HOSTED" | "BYOP";

export type ProviderConnectionResult = {
  ok: true;
  metadata?: Record<string, unknown>;
};

export type ProviderRoute = {
  workspaceId: string;
  capability: Capability;
  mode: ProviderMode;
  provider: string;
  integrationId: string | null;
  settings: Record<string, unknown>;
};

export interface AIProvider {
  generate(input: { messages: Array<{ role: "system" | "user" | "assistant"; content: string }>; model?: string }): Promise<{ text: string; raw?: unknown }>;
}

export interface CalendarProvider {
  getAvailability(input: { startsAt: Date; endsAt: Date; timezone: string; durationMinutes?: number }): Promise<Array<{ startsAt: Date; endsAt: Date }>>;
  book(input: { startsAt: Date; endsAt: Date; timezone: string; title: string; attendeeName?: string; attendeeEmail?: string }): Promise<{ externalId: string; startsAt: Date; endsAt: Date }>;
  reschedule(input: { externalId: string; startsAt: Date; endsAt: Date; timezone: string }): Promise<{ externalId: string; startsAt: Date; endsAt: Date }>;
  cancel(input: { externalId: string }): Promise<void>;
}

export type SmsDeliveryStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED";

export type NormalizedSmsEvent =
  | {
      type: "MESSAGE_RECEIVED";
      externalEventId: string;
      externalMessageId: string;
      from: string;
      to: string;
      text: string;
      occurredAt: Date | null;
    }
  | {
      type: "DELIVERY_UPDATED";
      externalEventId: string;
      externalMessageId: string;
      status: SmsDeliveryStatus;
      error: string | null;
      occurredAt: Date | null;
    };

export type SmsWebhookInput = {
  request: Request;
  rawBody: string;
  webhookUrl: string;
  contentType: string | null;
};

export interface SMSProvider {
  send(input: {
    to: string;
    from: string;
    text: string;
    statusCallbackUrl?: string;
    idempotencyKey?: string;
  }): Promise<{ externalId: string; status: SmsDeliveryStatus }>;
  verifyWebhook(input: SmsWebhookInput): Promise<boolean>;
  normalizeWebhook(input: SmsWebhookInput): Promise<NormalizedSmsEvent[]>;
}

export interface WhatsAppProvider {
  sendText(input: { phoneNumberId: string; to: string; text: string }): Promise<{ externalId: string }>;
  verifyWebhook(request: Request, rawBody: string): Promise<boolean>;
  normalizeWebhook(payload: unknown): Promise<unknown[]>;
}

export interface VoiceProvider {
  verifyWebhook(request: Request): Promise<boolean>;
  normalizeCallEvent(payload: unknown): Promise<unknown>;
  buildInboundResponse(input: { websocketUrl: string }): Promise<string>;
}

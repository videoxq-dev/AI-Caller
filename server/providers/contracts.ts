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
  generate(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    model?: string;
    maxOutputTokens?: number;
  }): Promise<{ text: string; raw?: unknown }>;
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

export type WhatsAppDeliveryStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";

export type NormalizedWhatsAppEvent =
  | {
      type: "MESSAGE_RECEIVED";
      externalEventId: string;
      externalMessageId: string;
      phoneNumberId: string;
      from: string;
      profileName: string | null;
      text: string;
      occurredAt: Date | null;
    }
  | {
      type: "DELIVERY_UPDATED";
      externalEventId: string;
      externalMessageId: string;
      phoneNumberId: string;
      status: WhatsAppDeliveryStatus;
      error: string | null;
      occurredAt: Date | null;
    };

export type WhatsAppWebhookInput = {
  request: Request;
  rawBody: string;
};

export interface WhatsAppProvider {
  sendText(input: { phoneNumberId: string; to: string; text: string }): Promise<{ externalId: string; status: "SENT" }>;
  sendTemplate(input: { phoneNumberId: string; to: string; templateName: string; languageCode: string; components?: unknown[] }): Promise<{ externalId: string; status: "SENT" }>;
  verifyWebhook(input: WhatsAppWebhookInput): Promise<boolean>;
  normalizeWebhook(input: WhatsAppWebhookInput): Promise<NormalizedWhatsAppEvent[]>;
}

export type VoiceWebhookInput = {
  request: Request;
  rawBody: string;
};

export type NormalizedVoiceEvent =
  | {
      type: "CALL_INITIATED";
      externalEventId: string;
      externalCallId: string;
      callControlId: string;
      from: string;
      to: string;
      occurredAt: Date | null;
    }
  | {
      type: "CALL_ANSWERED";
      externalEventId: string;
      externalCallId: string;
      callControlId: string;
      occurredAt: Date | null;
    }
  | {
      type: "DTMF_GATHERED";
      externalEventId: string;
      externalCallId: string;
      callControlId: string;
      digits: string;
      status: string | null;
      occurredAt: Date | null;
    }
  | {
      type: "TRANSCRIPTION";
      externalEventId: string;
      externalCallId: string;
      callControlId: string;
      transcript: string;
      isFinal: boolean;
      confidence: number | null;
      occurredAt: Date | null;
    }
  | {
      type: "SPEAK_ENDED";
      externalEventId: string;
      externalCallId: string;
      callControlId: string;
      occurredAt: Date | null;
    }
  | {
      type: "RECORDING_SAVED";
      externalEventId: string;
      externalCallId: string;
      recordingId: string | null;
      recordingUrl: string;
      format: "mp3" | "wav";
      startedAt: Date | null;
      endedAt: Date | null;
      occurredAt: Date | null;
    }
  | {
      type: "RECORDING_FAILED";
      externalEventId: string;
      externalCallId: string;
      error: string | null;
      occurredAt: Date | null;
    }
  | {
      type: "CALL_HANGUP";
      externalEventId: string;
      externalCallId: string;
      callControlId: string;
      cause: string | null;
      occurredAt: Date | null;
    };

export interface VoiceProvider {
  verifyWebhook(input: VoiceWebhookInput): Promise<boolean>;
  normalizeWebhook(input: VoiceWebhookInput): Promise<NormalizedVoiceEvent[]>;
  answer(input: { callControlId: string; streamUrl?: string | null; commandId?: string }): Promise<void>;
  gatherConsent(input: { callControlId: string; text: string; voice: string; language: string; commandId?: string }): Promise<void>;
  startTranscription(input: { callControlId: string; language: string; commandId?: string }): Promise<void>;
  startRecording(input: { callControlId: string; commandId?: string }): Promise<void>;
  speak(input: { callControlId: string; text: string; voice: string; language: string; speakingRate?: number; commandId?: string }): Promise<void>;
  hangup(input: { callControlId: string; commandId?: string }): Promise<void>;
}

import { randomUUID } from "node:crypto";
import { providerJson } from "@/server/providers/http";
import { parseTelnyxWebhookPublicKey, verifyTelnyxWebhookSignature } from "@/server/providers/telnyx-webhook";
import type { NormalizedVoiceEvent, VoiceProvider, VoiceWebhookInput } from "@/server/providers/contracts";

type TelnyxVoiceConfig = {
  apiKey: string;
  webhookPublicKey: string;
  fetcher?: typeof fetch;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateValue(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function commandId(value?: string) {
  return value?.trim() || randomUUID();
}

function languageForTranscription(language: string) {
  const normalized = language.trim();
  return normalized.includes("-") ? normalized.split("-")[0] : normalized;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function speakPayload(text: string, language: string, speakingRate?: number) {
  const rate = speakingRate ?? 1;
  if (Math.abs(rate - 1) < 0.001) return { payload: text, payload_type: "text" as const };
  const percent = Math.round((rate - 1) * 100);
  const rateValue = percent >= 0 ? `+${percent}%` : `${percent}%`;
  return {
    payload: `<speak version="1.0" xml:lang="${escapeXml(language)}"><prosody rate="${rateValue}">${escapeXml(text)}</prosody></speak>`,
    payload_type: "ssml" as const,
  };
}

export function normalizeTelnyxVoiceWebhook(input: VoiceWebhookInput): NormalizedVoiceEvent[] {
  let parsed: unknown;
  try { parsed = JSON.parse(input.rawBody); } catch { return []; }
  const root = record(parsed);
  const data = record(root?.data);
  const payload = record(data?.payload);
  const eventType = stringValue(data?.event_type);
  const externalEventId = stringValue(data?.id);
  const occurredAt = dateValue(data?.occurred_at);
  if (!payload || !eventType || !externalEventId) return [];

  const externalCallId = stringValue(payload.call_session_id);
  const callControlId = stringValue(payload.call_control_id);

  if (eventType === "call.initiated") {
    const from = stringValue(payload.from);
    const to = stringValue(payload.to);
    if (!externalCallId || !callControlId || !from || !to) return [];
    return [{ type: "CALL_INITIATED", externalEventId, externalCallId, callControlId, from, to, occurredAt }];
  }

  if (eventType === "call.answered") {
    if (!externalCallId || !callControlId) return [];
    return [{ type: "CALL_ANSWERED", externalEventId, externalCallId, callControlId, occurredAt }];
  }

  if (eventType === "call.speak.ended") {
    if (!externalCallId || !callControlId) return [];
    return [{ type: "SPEAK_ENDED", externalEventId, externalCallId, callControlId, occurredAt }];
  }

  if (eventType === "call.transcription") {
    const transcription = record(payload.transcription_data);
    const transcript = stringValue(transcription?.transcript);
    if (!externalCallId || !callControlId || !transcript) return [];
    return [{
      type: "TRANSCRIPTION",
      externalEventId,
      externalCallId,
      callControlId,
      transcript,
      isFinal: transcription?.is_final === true,
      confidence: numberValue(transcription?.confidence),
      occurredAt,
    }];
  }

  if (eventType === "call.recording.saved") {
    const urls = record(payload.recording_urls);
    const mp3 = stringValue(urls?.mp3);
    const wav = stringValue(urls?.wav);
    const recordingUrl = mp3 ?? wav;
    if (!externalCallId || !recordingUrl) return [];
    return [{
      type: "RECORDING_SAVED",
      externalEventId,
      externalCallId,
      recordingId: stringValue(payload.recording_id),
      recordingUrl,
      format: mp3 ? "mp3" : "wav",
      startedAt: dateValue(payload.recording_started_at ?? payload.start_time),
      endedAt: dateValue(payload.recording_ended_at ?? payload.end_time),
      occurredAt,
    }];
  }

  if (eventType === "call.recording.error") {
    if (!externalCallId) return [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const first = record(errors[0]);
    return [{
      type: "RECORDING_FAILED",
      externalEventId,
      externalCallId,
      error: stringValue(first?.detail) ?? stringValue(first?.title) ?? stringValue(payload.error),
      occurredAt,
    }];
  }

  if (eventType === "call.hangup") {
    if (!externalCallId || !callControlId) return [];
    return [{
      type: "CALL_HANGUP",
      externalEventId,
      externalCallId,
      callControlId,
      cause: stringValue(payload.hangup_cause) ?? stringValue(payload.cause),
      occurredAt,
    }];
  }

  return [];
}

export function createTelnyxVoiceProvider(config: TelnyxVoiceConfig): VoiceProvider {
  const fetcher = config.fetcher ?? fetch;
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error("Telnyx API key is required.");
  const publicKey = parseTelnyxWebhookPublicKey(config.webhookPublicKey);

  async function action(callControlId: string, name: string, body: Record<string, unknown>) {
    await providerJson(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${name}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      fetcher,
    );
  }

  return {
    async verifyWebhook(input) {
      return verifyTelnyxWebhookSignature(input.request, input.rawBody, publicKey);
    },

    async normalizeWebhook(input) {
      return normalizeTelnyxVoiceWebhook(input);
    },

    async answer(input) {
      await action(input.callControlId, "answer", {
        command_id: commandId(input.commandId),
        ...(input.streamUrl ? { stream_url: input.streamUrl, stream_track: "inbound_track" } : {}),
      });
    },

    async startTranscription(input) {
      await action(input.callControlId, "transcription_start", {
        command_id: commandId(input.commandId),
        language: languageForTranscription(input.language),
        transcription_engine: "Telnyx",
      });
    },

    async startRecording(input) {
      await action(input.callControlId, "record_start", {
        command_id: commandId(input.commandId),
        format: "mp3",
        channels: "single",
        play_beep: false,
      });
    },

    async speak(input) {
      await action(input.callControlId, "speak", {
        command_id: commandId(input.commandId),
        voice: input.voice,
        language: input.language,
        ...speakPayload(input.text, input.language, input.speakingRate),
      });
    },

    async hangup(input) {
      await action(input.callControlId, "hangup", {
        command_id: commandId(input.commandId),
      });
    },
  };
}

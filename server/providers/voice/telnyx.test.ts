import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTelnyxVoiceProvider, normalizeTelnyxVoiceWebhook } from "./telnyx";

function signedInput(body: string, privateKey: KeyObject) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(`${timestamp}|${body}`, "utf8"), privateKey).toString("base64");
  const request = new Request("https://app.example.com/api/webhooks/voice/telnyx/workspace", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": signature,
    },
    body,
  });
  return { request, rawBody: body };
}

describe("Telnyx voice adapter", () => {
  it("starts transcription on caller inbound audio only", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const sent = vi.fn(async () => new Response(JSON.stringify({ data: { result: "ok" } }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const provider = createTelnyxVoiceProvider({
      apiKey: "fixture-key",
      webhookPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      fetcher: sent,
    });
    await provider.startTranscription({
      callControlId: "control-1", language: "en-US", commandId: "cmd-1",
    });
    const [url, request] = vi.mocked(sent).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/actions/transcription_start");
    expect(JSON.parse(String(request.body))).toMatchObject({
      language: "en", transcription_engine: "Telnyx", transcription_tracks: "inbound",
    });
  });

  it("enables RTP/PCMU streaming only on selected Realtime answers", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const provider = createTelnyxVoiceProvider({
      apiKey: "fixture-key",
      webhookPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      fetcher: fetcher as unknown as typeof fetch,
    });
    const streamUrl = "wss://voice.example.com/?token=fixture";
    await provider.answer({ callControlId: "cc", streamUrl, commandId: "std" });
    await provider.answer({ callControlId: "cc", streamUrl,
      bidirectional: true, commandId: "realtime" });
    const standard = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const realtime = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(standard.stream_url).toBe(streamUrl);
    expect(standard).not.toHaveProperty("stream_bidirectional_mode");
    expect(standard).not.toHaveProperty("stream_bidirectional_codec");
    expect(realtime).toMatchObject({
      stream_url: streamUrl, stream_track: "inbound_track",
      stream_bidirectional_mode: "rtp", stream_bidirectional_codec: "PCMU",
      stream_codec: "PCMU",
    });
  });

  it("verifies and normalizes signed inbound call events", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const provider = createTelnyxVoiceProvider({ apiKey: "KEY123", webhookPublicKey: publicKeyPem });
    const body = JSON.stringify({
      data: {
        id: "evt-voice-1",
        event_type: "call.initiated",
        occurred_at: new Date().toISOString(),
        payload: {
          call_session_id: "call-session-1",
          call_control_id: "call-control-1",
          from: "+12025550100",
          to: "+12025550200",
        },
      },
    });
    const input = signedInput(body, privateKey);

    await expect(provider.verifyWebhook(input)).resolves.toBe(true);
    await expect(provider.normalizeWebhook(input)).resolves.toEqual([
      expect.objectContaining({
        type: "CALL_INITIATED",
        externalEventId: "evt-voice-1",
        externalCallId: "call-session-1",
        callControlId: "call-control-1",
        from: "+12025550100",
        to: "+12025550200",
      }),
    ]);
  });

  it("normalizes final transcription and recording callbacks", async () => {
    const transcription = JSON.stringify({
      data: {
        id: "evt-transcription",
        event_type: "call.transcription",
        payload: {
          call_session_id: "call-session-1",
          call_control_id: "call-control-1",
          transcription_data: { transcript: "Book tomorrow", is_final: true, confidence: 0.98 },
        },
      },
    });
    expect(normalizeTelnyxVoiceWebhook({ request: new Request("https://example.com"), rawBody: transcription })).toEqual([
      expect.objectContaining({
        type: "TRANSCRIPTION",
        transcript: "Book tomorrow",
        isFinal: true,
        confidence: 0.98,
      }),
    ]);

    const recording = JSON.stringify({
      data: {
        id: "evt-recording",
        event_type: "call.recording.saved",
        payload: {
          call_session_id: "call-session-1",
          recording_id: "recording-1",
          recording_urls: { wav: "https://example.com/recording.wav" },
        },
      },
    });
    expect(normalizeTelnyxVoiceWebhook({ request: new Request("https://example.com"), rawBody: recording })).toEqual([
      expect.objectContaining({
        type: "RECORDING_SAVED",
        recordingId: "recording-1",
        recordingUrl: "https://example.com/recording.wav",
        format: "wav",
      }),
    ]);
  });


  it("normalizes keypad consent gathers", () => {
    const body = JSON.stringify({
      data: {
        id: "evt-gather",
        event_type: "call.gather.ended",
        payload: {
          call_session_id: "call-session-1",
          call_control_id: "call-control-1",
          digits: "1",
          status: "valid",
        },
      },
    });
    expect(normalizeTelnyxVoiceWebhook({ request: new Request("https://example.com"), rawBody: body })).toEqual([
      expect.objectContaining({
        type: "DTMF_GATHERED",
        digits: "1",
        status: "valid",
      }),
    ]);
  });

  it("uses gather_using_speak for explicit recording consent", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { result: "ok" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = createTelnyxVoiceProvider({
      apiKey: "KEY123",
      webhookPublicKey: publicKeyPem,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await provider.gatherConsent({
      callControlId: "control-1",
      text: "Press 1 to agree, or press 2 to decline.",
      voice: "Azure.en-US-AvaMultilingualNeural",
      language: "en-US",
      commandId: "00000000-0000-5000-8000-000000000002",
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/calls/control-1/actions/gather_using_speak");
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      command_id: "00000000-0000-5000-8000-000000000002",
      minimum_digits: 1,
      maximum_digits: 1,
      maximum_tries: 1,
      valid_digits: "12",
    }));
  });

  it("sends idempotent Call Control actions with product voice payloads", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { result: "ok" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = createTelnyxVoiceProvider({
      apiKey: "KEY123",
      webhookPublicKey: publicKeyPem,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await provider.speak({
      callControlId: "control-1",
      text: "Hello",
      voice: "Azure.en-US-AvaMultilingualNeural",
      language: "en-US",
      speakingRate: 1,
      commandId: "00000000-0000-5000-8000-000000000001",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/calls/control-1/actions/speak");
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      command_id: "00000000-0000-5000-8000-000000000001",
      voice: "Azure.en-US-AvaMultilingualNeural",
      language: "en-US",
      payload: "Hello",
      payload_type: "text",
    }));
  });
});

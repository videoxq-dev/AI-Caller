import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    bufferedAmount = 0;
    sent: Record<string, unknown>[] = [];
    constructor() { super(); shared.client = this; }
    send(text: string) { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  return { default: MockWebSocket };
});
vi.mock("@/server/voice/repository", () => ({
  getVoiceCall: vi.fn(async () => ({
    id: "call-id", status: "ACTIVE", callControlId: "call-control",
    conversationId: "conversation", contactId: "contact",
    recordingConsentStatus: "ANNOUNCED",
    metadata: { phase: "ACTIVE", voiceTechnology: "REALTIME",
      realtimeModel: "gpt-realtime-2.1-mini", realtimeStreamId: "stream" },
  })),
  claimRealtimeStream: vi.fn(async () => ({ id: "call-id" })),
  finishRealtimeStream: vi.fn(async () => true),
  appendVoiceTranscriptSegment: vi.fn(async () => ({ id: "segment-id" })),
}));
vi.mock("@/server/domain/core/repository", () => ({
  appendMessage: vi.fn(async () => ({})),
}));
vi.mock("@/server/voice/realtime-tools", () => ({
  realtimeSystemInstructions: vi.fn(async () => "Answer the caller."),
  realtimeTools: [],
  runRealtimeBusinessTool: vi.fn(),
}));
vi.mock("@/server/voice/realtime-usage", () => ({
  recordRealtimeResponse: vi.fn(async () => ({})),
  settleRealtimeCall: vi.fn(async () => ({})),
  realtimeCreditBudgetReached: vi.fn(async () => false),
}));
vi.mock("@/server/env", () => ({
  getEnv: vi.fn(() => ({ HOSTED_AI_PROVIDER: "openai", HOSTED_AI_API_KEY: "fixture", VOICE_REALTIME_ENABLED: true })),
}));
vi.mock("@/server/credits/service", () => ({ releaseCreditReservation: vi.fn(async () => 0) }));
vi.mock("@/server/providers/voice/runtime", () => ({ resolveVoiceRuntime: vi.fn() }));
vi.mock("@/server/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { attachRealtimeMedia } from "./realtime-media";
import { runRealtimeBusinessTool } from "./realtime-tools";
import { recordRealtimeResponse } from "./realtime-usage";

type Socket = EventEmitter & {
  readyState: number;
  bufferedAmount: number;
  sent: Record<string, unknown>[];
  send: (value: string) => void;
  close: () => void;
};
function telnyxSocket(): Socket {
  const socket = new EventEmitter() as Socket;
  socket.readyState = 1;
  socket.bufferedAmount = 0;
  socket.sent = [];
  socket.send = value => socket.sent.push(JSON.parse(value) as Record<string, unknown>);
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  return socket;
}
function currentOpenai() { return shared.client as Socket; }

describe("Realtime Telnyx/OpenAI media contract", () => {
  afterEach(() => { shared.client = null; vi.clearAllMocks(); });

  it("bridges caller PCMU and sends correct RTP packets; clears buffered speech on interruption", async () => {
    const telnyx = telnyxSocket();
    const bridge = attachRealtimeMedia({
      telnyx: telnyx as unknown as WebSocket, identity: { workspaceId: "ws", callId: "call-id", externalCallId: "telnyx-call" },
      streamId: "stream",
    });
    await vi.waitFor(() => expect(shared.client).not.toBeNull());
    const openai = currentOpenai();
    openai.emit("open");
    await vi.waitFor(() => expect(openai.sent.some(v => v.type === "session.update")).toBe(true));
    const update = openai.sent.find(v => v.type === "session.update");
    expect((update?.session as Record<string, unknown>).output_modalities).toEqual(["audio"]);
    openai.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    const callerAudio = Buffer.alloc(160, 0x55);
    bridge.onMedia(callerAudio.toString("base64"));
    await vi.waitFor(() => expect(openai.sent.some(v => v.type === "input_audio_buffer.append")).toBe(true));
    expect(openai.sent.find(v => v.type === "input_audio_buffer.append")?.audio)
      .toBe(callerAudio.toString("base64"));

    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.created", response: { id: "r1" },
    })));
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.output_audio.delta", response_id: "r1",
      delta: Buffer.alloc(160, 0x6f).toString("base64"),
    })));
    await vi.waitFor(() => expect(telnyx.sent.some(v => v.event === "media")).toBe(true));
    const packet = Buffer.from(String((telnyx.sent.find(v => v.event === "media")?.media as Record<string, unknown>).payload), "base64");
    expect(packet.length).toBe(172);
    expect(packet[0]).toBe(0x80);
    expect(packet[1]).toBe(0);
    expect(packet.subarray(12)).toEqual(Buffer.alloc(160, 0x6f));

    openai.emit("message", Buffer.from(JSON.stringify({
      type: "input_audio_buffer.speech_started",
    })));
    expect(telnyx.sent.some(v => v.event === "clear")).toBe(true);
    const prior = telnyx.sent.filter(v => v.event === "media").length;
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.output_audio.delta", response_id: "r1",
      delta: Buffer.alloc(160, 0x5f).toString("base64"),
    })));
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.output_audio.done", response_id: "r1",
    })));
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(telnyx.sent.filter(v => v.event === "media")).toHaveLength(prior);
    // Another VAD event must not re-enable media from the older response.
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "input_audio_buffer.speech_started",
    })));
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.output_audio.delta", response_id: "r1",
      delta: Buffer.alloc(160, 0x4f).toString("base64"),
    })));
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(telnyx.sent.filter(v => v.event === "media")).toHaveLength(prior);
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.done", response: { id: "r1", status: "cancelled",
        usage: { input_tokens: 0, output_tokens: 0,
          input_token_details: {}, output_token_details: {} } },
    })));
    await bridge.stop();
    expect(telnyx.readyState).toBe(3);
  });
  it("suppresses interrupted stale tools but forwards the newest tool and deduplicates usage", async () => {
    vi.mocked(runRealtimeBusinessTool).mockResolvedValue({
      ok: true, kind: "booking_state",
      data: { details: { date: "2026-09-26" }, availabilityMustBeRechecked: true },
    } as Awaited<ReturnType<typeof runRealtimeBusinessTool>>);
    const telnyx = telnyxSocket();
    const bridge = attachRealtimeMedia({
      telnyx: telnyx as unknown as WebSocket,
      identity: { workspaceId: "ws", callId: "call-id", externalCallId: "telnyx-call" },
      streamId: "stream",
    });
    await vi.waitFor(() => expect(shared.client).not.toBeNull());
    const openai = currentOpenai();
    openai.emit("open");
    openai.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.created", response: { id: "stale" },
    })));
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "input_audio_buffer.speech_started",
    })));
    const toolItem = { type: "function_call",
      call_id: "tool-1", name: "capture_booking_details",
      arguments: JSON.stringify({ date: "2026-09-26" }) };
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.output_item.done", response_id: "stale", item: toolItem,
    })));
    expect(runRealtimeBusinessTool).not.toHaveBeenCalled();
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.created", response: { id: "new" },
    })));
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.output_item.done", response_id: "new", item: toolItem,
    })));
    await vi.waitFor(() => expect(runRealtimeBusinessTool).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runRealtimeBusinessTool).mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws", callId: "call-id", streamId: "stream",
      name: "capture_booking_details",
    });
    // Never create the next response while the tool-only provider response is
    // still active; wait for response.done and the completed tool output.
    expect(openai.sent.filter(v => v.type === "response.create")).toHaveLength(0);
    const usage = { input_tokens: 1, output_tokens: 1,
      input_token_details: { text_tokens: 1 }, output_token_details: { audio_tokens: 1 } };
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.done", response: { id: "stale", status: "cancelled", usage },
    })));
    openai.emit("message", Buffer.from(JSON.stringify({
      type: "response.done", response: { id: "new", status: "completed", usage },
    })));
    await vi.waitFor(() => expect(recordRealtimeResponse).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(openai.sent.filter(v => v.type === "response.create")).toHaveLength(1));
    await bridge.stop();
    expect(telnyx.readyState).toBe(3);
  });

});

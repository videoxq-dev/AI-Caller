import WebSocket from "ws";
import { appendMessage } from "@/server/domain/core/repository";
import { releaseCreditReservation } from "@/server/credits/service";
import { getEnv } from "@/server/env";
import { logger } from "@/server/observability/logger";
import { getVoiceCall, appendVoiceTranscriptSegment, claimRealtimeStream, finishRealtimeStream } from "./repository";
import { recordRealtimeResponse, settleRealtimeCall } from "./realtime-usage";
import { realtimeSystemInstructions, realtimeTools, runRealtimeBusinessTool } from "./realtime-tools";
import { realtimeCreditBudgetReached } from "./realtime-usage";
import { resolveVoiceRuntime } from "@/server/providers/voice/runtime";
import { TelnyxPcmuRtpPacketizer } from "./telnyx-rtp";

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_OPENING_AUDIO_BYTES = 256 * 1024;
const MAX_AUDIO_DELTA_BYTES = 128 * 1024;
const AUDIO_PACKET_BYTES = 160; // 20 ms of 8-kHz PCMU
const MAX_OUTPUT_PACKETS = 1500; // 30 seconds of queued AI speech
const MAX_CALL_MS = 10 * 60 * 1000;
const OPENAI_READY_MS = 15_000;
const OPENING_WAIT_MS = 30_000;

export type VoiceGatewayIdentity = {
  workspaceId: string;
  callId: string;
  externalCallId: string;
};

type BridgeOptions = {
  telnyx: WebSocket;
  identity: VoiceGatewayIdentity;
  streamId: string;
};

type RealtimeEvent = {
  type?: unknown;
  delta?: unknown;
  response_id?: unknown;
  item_id?: unknown;
  transcript?: unknown;
  response?: unknown;
  item?: unknown;
  error?: unknown;
};

function object(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
}

function exactBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value || value.length > MAX_AUDIO_DELTA_BYTES * 2
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_AUDIO_DELTA_BYTES
    && bytes.toString("base64") === value ? bytes : null;
}

/** The stream is authenticated before construction. No vendor credentials leave the gateway. */
export function attachRealtimeMedia({ telnyx, identity, streamId }: BridgeOptions) {
  const { workspaceId, callId } = identity;
  let upstream: WebSocket | null = null;
  let open = true;
  let ready = false;
  let error = false;
  let sessionConfigured = false;
  let claimed = false;
  let activeResponseId: string | null = null;
  let interruptedResponseId: string | null = null;
  let pendingResponses = new Set<string>();
  const pendingWork = new Set<Promise<unknown>>();
  const initialAudio: Buffer[] = [];
  const outboundPackets: Buffer[] = [];
  let initialBytes = 0;
  let outputTail = Buffer.alloc(0);
  const rtp = new TelnyxPcmuRtpPacketizer();
  let toolEscalated = false;
  let speechAllowed = false;
  let providerCloseRequested = false;
  let budgetHangupRequested = false;
  let escalationResponseComplete = false;
  let toolSerial = Promise.resolve();
  const handledToolCalls = new Set<string>();
  const responseEpochs = new Map<string, number>();
  let callerSpeechEpoch = 0;
  const startedAt = Date.now();

  function track(promise: Promise<unknown>) {
    pendingWork.add(promise);
    void promise.finally(() => pendingWork.delete(promise)).catch(() => undefined);
  }

  function sendTelnyx(packet: unknown) {
    if (!open || telnyx.readyState !== WebSocket.OPEN) return;
    if (telnyx.bufferedAmount > MAX_BUFFERED_BYTES) return fail("telnyx-output-backpressure");
    telnyx.send(JSON.stringify(packet));
  }

  function sendOpenAI(packet: unknown) {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) return fail("openai-input-backpressure");
    upstream.send(JSON.stringify(packet));
  }

  function clearAudio() {
    outboundPackets.length = 0;
    outputTail = Buffer.alloc(0);
    sendTelnyx({ event: "clear", stream_id: streamId });
  }

  function fail(reason: string) {
    if (!open) return;
    error = true;
    logger.warn({ workspaceId, callId, reason }, "Realtime media bridge ended early");
    void stop(false);
  }

  async function hangupForBudget(reason: "budget" | "max-duration" | "escalation") {
    if (!open || budgetHangupRequested) return;
    budgetHangupRequested = true;
    const call = await getVoiceCall(workspaceId, callId);
    if (!call || !call.callControlId || call.status !== "ACTIVE") return;
    try {
      const runtime = await resolveVoiceRuntime(workspaceId);
      if (runtime.mode !== "HOSTED") throw new Error("Realtime requires hosted Telnyx.");
      await runtime.provider.hangup({
        callControlId: call.callControlId,
        commandId: `realtime-${reason}-${call.id}`,
      });
      logger.info({ workspaceId, callId, reason }, "Realtime call hangup requested");
    } catch (cause) {
      logger.error({ err: cause, workspaceId, callId, reason },
        "Unable to hang up Realtime call after budget or escalation; operator follow-up required");
      fail("realtime-hangup-failure");
    }
  }

  function feedAudio(bytes: Buffer) {
    if (!open || !ready || !speechAllowed) return;
    sendOpenAI({ type: "input_audio_buffer.append", audio: bytes.toString("base64") });
  }

  const ticker = setInterval(() => {
    if (!open) return;
    if (Date.now() - startedAt > MAX_CALL_MS) {
      void hangupForBudget("max-duration");
      return;
    }
    if (escalationResponseComplete && outboundPackets.length === 0 && outputTail.length === 0) {
      escalationResponseComplete = false;
      setTimeout(() => void hangupForBudget("escalation"), 500).unref();
      return;
    }
    if (!speechAllowed || !outboundPackets.length) return;
    const packet = outboundPackets.shift();
    if (packet) sendTelnyx({
      event: "media", stream_id: streamId, media: { payload: rtp.packet(packet).toString("base64") },
    });
  }, 20);
  ticker.unref();

  function onMedia(encoded: unknown) {
    if (!open) return;
    const bytes = exactBase64(encoded);
    if (!bytes) return fail("invalid-pcmu-payload");
    if (!ready || !speechAllowed) {
      if (initialBytes + bytes.length > MAX_OPENING_AUDIO_BYTES) {
        // Skip oldest frames of a long greeting, not the latest caller request.
        while (initialAudio.length && initialBytes + bytes.length > MAX_OPENING_AUDIO_BYTES) {
          initialBytes -= initialAudio.shift()!.length;
        }
      }
      initialAudio.push(bytes);
      initialBytes += bytes.length;
      return;
    }
    feedAudio(bytes);
  }

  function queueOutput(raw: unknown, responseId: unknown) {
    if (!open || !speechAllowed
      || (typeof responseId === "string" && responseId === interruptedResponseId)) return;
    const chunk = exactBase64(raw);
    if (!chunk) return fail("invalid-openai-audio");
    let bytes = Buffer.concat([outputTail, chunk]);
    while (bytes.length >= AUDIO_PACKET_BYTES) {
      if (outboundPackets.length >= MAX_OUTPUT_PACKETS) return fail("ai-output-overflow");
      outboundPackets.push(bytes.subarray(0, AUDIO_PACKET_BYTES));
      bytes = bytes.subarray(AUDIO_PACKET_BYTES);
    }
    outputTail = bytes;
  }

  async function saveAssistantTranscript(raw: RealtimeEvent) {
    const transcript = typeof raw.transcript === "string" ? raw.transcript.trim() : "";
    const id = typeof raw.response_id === "string" ? raw.response_id : "";
    const itemId = typeof raw.item_id === "string" ? raw.item_id : "";
    if (!transcript || !id || !itemId) return;
    const call = await getVoiceCall(workspaceId, callId);
    if (!call || call.metadata.voiceTechnology !== "REALTIME") return;
    const eventId = `${id}:${itemId}:ai`;
    const segment = await appendVoiceTranscriptSegment(workspaceId, callId, {
      speaker: "AI", text: transcript, externalEventId: eventId,
    });
    await appendMessage(workspaceId, call.conversationId, {
      channel: "PHONE", direction: "OUTBOUND", senderType: "AI",
      contentType: "CALL_TRANSCRIPT", body: transcript,
      provider: "openai-realtime", externalMessageId: eventId, status: "SENT",
      metadata: { voiceCallId: callId, transcriptSegmentId: segment.id,
        voiceMode: call.mode, realtimeModel: call.metadata.realtimeModel },
    });
  }

  async function runTool(raw: RealtimeEvent, epoch: number) {
    const item = object(raw.item);
    if (item.type !== "function_call" || typeof item.call_id !== "string"
      || typeof item.name !== "string" || typeof item.arguments !== "string") return;
    if (handledToolCalls.has(item.call_id) || epoch !== callerSpeechEpoch) return;
    handledToolCalls.add(item.call_id);
    const call = await getVoiceCall(workspaceId, callId);
    if (!call || !open || !ready || epoch !== callerSpeechEpoch
      || call.status !== "ACTIVE" || call.metadata.realtimeStreamId !== streamId
      || call.metadata.voiceTechnology !== "REALTIME") return;
    const result = await runRealtimeBusinessTool({
      workspaceId, callId, streamId, conversationId: call.conversationId, contactId: call.contactId,
      name: item.name, arguments: item.arguments,
    });
    if (!open) return;
    if (result.ok && result.kind === "escalation") toolEscalated = true;
    sendOpenAI({ type: "conversation.item.create", item: {
      type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result),
    } });
    sendOpenAI({ type: "response.create", response: toolEscalated
      ? { instructions: "Say only: I have flagged your request for staff follow-up. I cannot transfer this call live. Do not call more tools.", tool_choice: "none" }
      : {} });
  }

  function onRealtimeMessage(payload: WebSocket.RawData) {
    let event: RealtimeEvent;
    try { event = JSON.parse(payload.toString()) as RealtimeEvent; }
    catch { return fail("malformed-openai-event"); }

    if (event.type === "session.updated") {
      sessionConfigured = true;
      ready = true;
      if (speechAllowed) {
        for (const bytes of initialAudio) feedAudio(bytes);
        initialAudio.length = 0;
        initialBytes = 0;
      }
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      callerSpeechEpoch += 1;
      interruptedResponseId = activeResponseId;
      clearAudio();
      return;
    }
    if (event.type === "response.created") {
      const response = object(event.response);
      if (typeof response.id === "string") {
        activeResponseId = response.id;
        responseEpochs.set(response.id, callerSpeechEpoch);
        pendingResponses.add(response.id);
      }
      return;
    }
    if (event.type === "response.output_audio.delta") {
      queueOutput(event.delta, event.response_id);
      return;
    }
    if (event.type === "response.output_audio.done") {
      if (event.response_id === interruptedResponseId) {
        outputTail = Buffer.alloc(0);
        return;
      }
      if (outputTail.length > 0) {
        const last = Buffer.alloc(AUDIO_PACKET_BYTES, 0xff);
        outputTail.copy(last);
        if (outboundPackets.length >= MAX_OUTPUT_PACKETS) return fail("ai-output-overflow");
        outboundPackets.push(last);
        outputTail = Buffer.alloc(0);
      }
      return;
    }
    if (event.type === "response.output_audio_transcript.done") {
      track(saveAssistantTranscript(event).catch(() => { error = true; }));
      return;
    }
    if (event.type === "response.output_item.done") {
      const epoch = typeof event.response_id === "string"
        ? responseEpochs.get(event.response_id) : undefined;
      if (epoch === undefined || epoch !== callerSpeechEpoch) return;
      toolSerial = toolSerial.then(() => runTool(event, epoch)).catch(err => {
        logger.error({ err, workspaceId, callId }, "Realtime business tool failed");
        error = true;
        fail("realtime-tool-failure");
      });
      track(toolSerial);
      return;
    }
    if (event.type === "response.done") {
      const response = object(event.response);
      const responseId = typeof response.id === "string" ? response.id : null;
      if (!responseId) return fail("missing-response-id");
      const status = typeof response.status === "string" ? response.status : "";
      // Cancelled responses may contain chargeable tokens; persist if present.
      if (response.usage) {
        track(recordRealtimeResponse(workspaceId, callId, responseId, response.usage)
          .then(async () => {
            if (open && await realtimeCreditBudgetReached(workspaceId, callId)) {
              logger.warn({ workspaceId, callId }, "Realtime voice credit hold budget reached");
              await hangupForBudget("budget");
            }
          })
          .catch(err => {
            logger.error({ err, workspaceId, callId }, "Unable to store or budget Realtime usage");
            error = true;
          }));
      } else {
        // Cancelled generation can still have billable tokens. Without a
        // provider usage object the final invoice cannot be reconstructed.
        error = true;
        logger.warn({ workspaceId, callId, responseId, status },
          "Realtime response completed without authoritative token usage");
      }
      pendingResponses.delete(responseId);
      responseEpochs.delete(responseId);
      if (activeResponseId === responseId) activeResponseId = null;
      if (toolEscalated && !pendingResponses.size) {
        escalationResponseComplete = true;
        sendOpenAI({ type: "session.update", session: { type: "realtime",
          audio: { input: { turn_detection: { type: "semantic_vad",
            create_response: false, interrupt_response: true } } } } });
      }
      return;
    }
    if (event.type === "error") {
      logger.warn({ workspaceId, callId, providerCode: object(event.error).code ?? "unknown" },
        "OpenAI Realtime returned an error");
      fail("openai-session-error");
    }
  }

  async function waitUntilGreetingEnds() {
    const until = Date.now() + OPENING_WAIT_MS;
    while (open && Date.now() < until) {
      const call = await getVoiceCall(workspaceId, callId);
      if (!call || call.metadata.voiceTechnology !== "REALTIME"
        || !["RINGING", "ACTIVE"].includes(call.status))
        throw new Error("Realtime call is no longer active.");
      if (call.status === "ACTIVE" && call.metadata.phase === "ACTIVE" && ["ANNOUNCED", "GRANTED"]
        .includes(call.recordingConsentStatus)) return call;
      if (["ENDED", "TERMINATING", "HUMAN", "DECLINED_NOTICE"].includes(String(call.metadata.phase)))
        throw new Error("Realtime call is not authorized to stream.");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error("Realtime call opening timed out.");
  }

  async function start() {
    try {
      const call = await waitUntilGreetingEnds();
      if (!open) return;
      const claimedCall = await claimRealtimeStream(workspaceId, callId, streamId);
      if (!claimedCall) throw new Error("Realtime call stream already claimed.");
      claimed = true;
      const instructions = await realtimeSystemInstructions(workspaceId, call.conversationId);
      if (!open) return;
      const env = getEnv();
      if (!env.VOICE_REALTIME_ENABLED || env.HOSTED_AI_PROVIDER !== "openai"
        || !env.HOSTED_AI_API_KEY) throw new Error("Realtime configuration disabled.");
      const model = call.metadata.realtimeModel;
      if (model !== "gpt-realtime-2.1" && model !== "gpt-realtime-2.1-mini")
        throw new Error("Invalid per-call Realtime model.");
      const ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
        { headers: { Authorization: `Bearer ${env.HOSTED_AI_API_KEY}` },
          handshakeTimeout: OPENAI_READY_MS, maxPayload: 1024 * 1024 },
      );
      upstream = ws;
      ws.on("open", () => sendOpenAI({ type: "session.update", session: {
        type: "realtime",
        instructions,
        output_modalities: ["audio"],
        max_output_tokens: 512,
        audio: {
          input: { format: { type: "audio/pcmu" },
            turn_detection: { type: "semantic_vad", eagerness: "medium",
              create_response: true, interrupt_response: true } },
          output: { format: { type: "audio/pcmu" }, voice: "marin" },
        },
        tools: realtimeTools, tool_choice: "auto",
      } }));
      ws.on("message", onRealtimeMessage);
      ws.on("error", err => {
        logger.warn({ err, workspaceId, callId }, "Realtime provider socket failed");
        fail("openai-socket-error");
      });
      ws.on("close", () => {
        if (open && !providerCloseRequested) fail("openai-socket-closed");
      });
      const timeout = setTimeout(() => {
        if (!sessionConfigured) fail("openai-session-timeout");
      }, OPENAI_READY_MS);
      timeout.unref();
      speechAllowed = true;
      // If session.updated arrived before we switched speechAllowed, flush.
      if (ready) {
        for (const frame of initialAudio) feedAudio(frame);
        initialAudio.length = 0;
        initialBytes = 0;
      }
    } catch (err) {
      logger.warn({ err, workspaceId, callId }, "Realtime session was not established");
      fail("realtime-start-failure");
    }
  }

  async function stop(providerConfirmed = true) {
    if (!open) return;
    open = false;
    clearInterval(ticker);
    providerCloseRequested = true;
    // Ask OpenAI to finish/cancel and return response.done.usage before the
    // telephony socket disappears. A cancelled response can still cost tokens.
    if (upstream && upstream.readyState === WebSocket.OPEN && pendingResponses.size > 0) {
      upstream.send(JSON.stringify({ type: "response.cancel" }));
      const until = Date.now() + 3000;
      while (pendingResponses.size > 0 && Date.now() < until
        && upstream.readyState === WebSocket.OPEN) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(1000);
    if (upstream && upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    // Do not claim authoritative billing if any chargeable response was lost.
    await Promise.allSettled([...pendingWork]);
    const verified = providerConfirmed && !error && ready && pendingResponses.size === 0;
    if (claimed) {
      const completed = await finishRealtimeStream(workspaceId, callId, streamId, verified);
      if (completed && verified) {
        await settleRealtimeCall(workspaceId, callId);
      } else if (completed && !verified) {
        const call = await getVoiceCall(workspaceId, callId);
        if (call?.status === "COMPLETED"
          && typeof call.metadata.realtimeReservationId === "string") {
          await releaseCreditReservation(workspaceId, call.metadata.realtimeReservationId);
        }
        logger.error({ workspaceId, callId, streamId },
          "Realtime session usage incomplete; manual provider invoice reconciliation required");
      }
    }
    if (telnyx.readyState === WebSocket.OPEN) telnyx.close(1000, "Media stream stopped");
    logger.info({ workspaceId, callId, verified, durationMs: Date.now() - startedAt },
      "Realtime media stream closed");
  }

  void start();
  return { onMedia, stop };
}

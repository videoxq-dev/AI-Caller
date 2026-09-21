import WebSocket from "ws";
import { appendMessage } from "@/server/domain/core/repository";
import { releaseCreditReservation } from "@/server/credits/service";
import { getEnv } from "@/server/env";
import { logger } from "@/server/observability/logger";
import { getVoiceCall, appendVoiceTranscriptSegment, claimRealtimeStream, finishRealtimeStream } from "./repository";
import { recordRealtimeResponse, settleRealtimeCall } from "./realtime-usage";
import { realtimeSessionContext, runRealtimeBusinessTool } from "./realtime-tools";
import { realtimeCreditBudgetReached } from "./realtime-usage";
import { resolveVoiceRuntime } from "@/server/providers/voice/runtime";
import { resolveVoiceProfile } from "./voices";

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
  const interruptedResponseIds = new Set<string>();
  let pendingResponses = new Set<string>();
  const pendingWork = new Set<Promise<unknown>>();
  const initialAudio: Buffer[] = [];
  const outboundPackets: Buffer[] = [];
  let initialBytes = 0;
  let outputTail = Buffer.alloc(0);
  let toolEscalated = false;
  let speechAllowed = false;
  let providerCloseRequested = false;
  let budgetHangupRequested = false;
  let escalationResponseComplete = false;
  let toolSerial = Promise.resolve();
  const responseToolCounts = new Map<string, number>();
  const completedToolResponses = new Set<string>();
  const resumedToolResponses = new Set<string>();
  const responseStatuses = new Map<string, string>();
  const responseWithTools = new Set<string>();
  const handledToolCalls = new Set<string>();
  const responseEpochs = new Map<string, number>();
  let callerSpeechEpoch = 0;
  let callerLastSpeechStoppedAt: number | null = null;
  const measuredResponses = new Set<string>();
  let priorConversation = "";
  let historyInjected = false;
  let openingMessage = "How can I help you today?";
  let openingRequested = false;
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
    // Persist failure state even if the carrier already initiated stop():
    // a usage write can reject while stop() drains pending work.
    error = true;
    if (!open) return;
    logger.warn({ workspaceId, callId, reason }, "Realtime media bridge ended early");
    // Closing the media WebSocket alone would strand a live telephone call in
    // silence. End the provider call as well, even on OpenAI session failure.
    void hangupForBudget("bridge-error");
    void stop(false);
  }

  async function hangupForBudget(reason: "budget" | "max-duration" | "escalation" | "bridge-error") {
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

  function requestOpening() {
    if (!open || !ready || !speechAllowed || openingRequested) return;
    openingRequested = true;
    sendOpenAI({
      type: "response.create",
      response: {
        instructions: `Begin the live call by saying exactly this opening greeting and nothing else: ${JSON.stringify(openingMessage)}. Do not call tools in this response.`,
        tool_choice: "none",
      },
    });
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
      // Telnyx WebSocket `rtp` mode expects the RTP *payload*, not a full
      // 12-byte RTP header plus payload. Sending the header as PCMU creates
      // periodic audible interference every 172 decoded bytes (46.5 Hz).
      event: "media", stream_id: streamId, media: { payload: packet.toString("base64") },
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
      || (typeof responseId === "string" && interruptedResponseIds.has(responseId))) return;
    const chunk = exactBase64(raw);
    if (!chunk) return fail("invalid-openai-audio");
    if (typeof responseId === "string" && callerLastSpeechStoppedAt != null
      && !measuredResponses.has(responseId)) {
      measuredResponses.add(responseId);
      logger.info({ workspaceId, callId, responseId,
        modelAudioFirstByteLatencyMs: Date.now() - callerLastSpeechStoppedAt },
        "Realtime measured speech-end to first generated audio");
      callerLastSpeechStoppedAt = null;
    }
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
        voiceMode: call.mode, realtimeModel: call.metadata.realtimeModel,
        potentiallyInterrupted: interruptedResponseIds.has(id) },
    });
  }

  function resumeAfterTools(responseId: string, epoch: number) {
    if (!open || epoch !== callerSpeechEpoch || resumedToolResponses.has(responseId)
      || !completedToolResponses.has(responseId)
      || responseStatuses.get(responseId) !== "completed"
      || (responseToolCounts.get(responseId) ?? 0) !== 0) return;
    resumedToolResponses.add(responseId);
    sendOpenAI({ type: "response.create", response: toolEscalated
      ? { instructions: "Say only: I have flagged your request for staff follow-up. I cannot transfer this call live. Do not call more tools.", tool_choice: "none" }
      : {} });
    if (toolEscalated) {
      sendOpenAI({ type: "session.update", session: { type: "realtime",
        audio: { input: { turn_detection: { type: "semantic_vad",
          create_response: false, interrupt_response: true } } } } });
    }
  }

  async function runTool(raw: RealtimeEvent, epoch: number) {
    const item = object(raw.item);
    if (item.type !== "function_call" || typeof item.call_id !== "string"
      || typeof item.name !== "string" || typeof item.arguments !== "string") return;
    if (epoch !== callerSpeechEpoch) return;
    const call = await getVoiceCall(workspaceId, callId);
    if (!call || !open || !ready || epoch !== callerSpeechEpoch
      || call.status !== "ACTIVE" || call.metadata.realtimeStreamId !== streamId
      || call.metadata.voiceTechnology !== "REALTIME") return;
    const result = await runRealtimeBusinessTool({
      workspaceId, callId, streamId, conversationId: call.conversationId, contactId: call.contactId,
      name: item.name, arguments: item.arguments,
      isCurrentTurn: () => open && epoch === callerSpeechEpoch,
    });
    if (!open) return;
    if (result.ok && result.kind === "escalation") toolEscalated = true;
    sendOpenAI({ type: "conversation.item.create", item: {
      type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result),
    } });
  }

  function onRealtimeMessage(payload: WebSocket.RawData) {
    let event: RealtimeEvent;
    try { event = JSON.parse(payload.toString()) as RealtimeEvent; }
    catch { return fail("malformed-openai-event"); }

    if (event.type === "session.updated") {
      sessionConfigured = true;
      if (!historyInjected) {
        historyInjected = true;
        if (priorConversation) sendOpenAI({
          type: "conversation.item.create",
          item: { type: "message", role: "user", status: "completed",
            content: [{ type: "input_text",
              text: "Prior workspace conversation excerpts for reference only; the current caller request arrives via live audio:\\n" + priorConversation }] },
        });
      }
      ready = true;
      if (speechAllowed) {
        requestOpening();
        for (const bytes of initialAudio) feedAudio(bytes);
        initialAudio.length = 0;
        initialBytes = 0;
      }
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      callerLastSpeechStoppedAt = Date.now();
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      // Semantic VAD can be triggered by line/background noise. Keep barge-in
      // responsive but make this specific source of cut-off observable.
      if (pendingResponses.size > 0 || outboundPackets.length > 0 || outputTail.length > 0) {
        logger.warn({ workspaceId, callId,
          interruptedActiveResponses: pendingResponses.size,
          queuedAudioMs: Math.round(
            (outboundPackets.length * AUDIO_PACKET_BYTES + outputTail.length) / 8,
          ) }, "Realtime caller activity interrupted assistant playback");
      }
      callerSpeechEpoch += 1;
      for (const id of pendingResponses) interruptedResponseIds.add(id);
      clearAudio();
      return;
    }
    if (event.type === "response.created") {
      const response = object(event.response);
      if (typeof response.id === "string") {
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
      if (typeof event.response_id === "string" && interruptedResponseIds.has(event.response_id)) {
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
      track(saveAssistantTranscript(event).catch(err => {
        logger.error({ err, workspaceId, callId },
          "Unable to archive Realtime assistant transcript; call billing remains independent");
      }));
      return;
    }
    if (event.type === "response.output_item.done") {
      const responseId = typeof event.response_id === "string" ? event.response_id : "";
      const epoch = responseEpochs.get(responseId);
      const item = object(event.item);
      const callKey = typeof item.call_id === "string" ? item.call_id : "";
      if (epoch === undefined || epoch !== callerSpeechEpoch
        || item.type !== "function_call" || !callKey
        || handledToolCalls.has(callKey)) return;
      handledToolCalls.add(callKey);
      responseWithTools.add(responseId);
      responseToolCounts.set(responseId, (responseToolCounts.get(responseId) ?? 0) + 1);
      toolSerial = toolSerial.then(async () => {
        try {
          await runTool(event, epoch);
        } catch (err) {
          // A transient business-tool failure must be reported truthfully to
          // the model, not tear down an otherwise healthy telephone call.
          // Keep usage certification failed for reconciliation, while allowing
          // the assistant to tell the caller that the action did not complete.
          error = true;
          logger.error({ err, workspaceId, callId }, "Realtime business tool failed");
          sendOpenAI({ type: "conversation.item.create", item: {
            type: "function_call_output", call_id: callKey,
            output: JSON.stringify({ ok: false,
              reason: "The requested action could not be completed. No booking or change was completed. Ask for corrected or missing details when appropriate." }),
          } });
        } finally {
          responseToolCounts.set(responseId,
            Math.max(0, (responseToolCounts.get(responseId) ?? 1) - 1));
          resumeAfterTools(responseId, epoch);
        }
      });
      track(toolSerial);
      return;
    }
    if (event.type === "response.done") {
      const response = object(event.response);
      const responseId = typeof response.id === "string" ? response.id : null;
      if (!responseId) return fail("missing-response-id");
      const status = typeof response.status === "string" ? response.status : "";
      if (status !== "completed") {
        const reason = object(response.incomplete_details).reason;
        logger.warn({ workspaceId, callId, responseId, status,
          incompleteReason: typeof reason === "string" && /^[a-z_]{1,50}$/.test(reason)
            ? reason : "unknown" },
        "Realtime provider ended assistant response before completion");
      }
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
            fail("realtime-usage-write-failure");
          }));
      } else {
        // Cancelled generation can still have billable tokens. Without a
        // provider usage object the final invoice cannot be reconstructed.
        logger.warn({ workspaceId, callId, responseId, status,
          toolResponse: responseWithTools.has(responseId) },
        "Realtime response completed without authoritative token usage");
        if (responseWithTools.has(responseId)) {
          // Function-call-only responses can omit usage even though the
          // follow-up spoken response is still valid. Continue the call, but
          // fail final usage certification so provider billing is reconciled.
          error = true;
        } else {
          fail("realtime-usage-missing");
        }
      }
      pendingResponses.delete(responseId);
      responseStatuses.set(responseId, status);
      const epoch = responseEpochs.get(responseId);
      responseEpochs.delete(responseId);
      if (responseWithTools.has(responseId)) {
        completedToolResponses.add(responseId);
        if (epoch !== undefined) resumeAfterTools(responseId, epoch);
      } else if (toolEscalated && !pendingResponses.size
        && status === "completed") {
        // Wait for the *spoken follow-up* response, not the tool-only turn.
        escalationResponseComplete = true;
      }
      return;
    }
    if (event.type === "error") {
      logger.warn({ workspaceId, callId, providerCode: object(event.error).code ?? "unknown" },
        "OpenAI Realtime returned an error");
      fail("openai-session-error");
    }
  }

  async function waitUntilGreetingEnds(allowOpening = false) {
    const until = Date.now() + OPENING_WAIT_MS;
    while (open && Date.now() < until) {
      const call = await getVoiceCall(workspaceId, callId);
      if (!call || call.metadata.voiceTechnology !== "REALTIME"
        || !["RINGING", "ACTIVE"].includes(call.status))
        throw new Error("Realtime call is no longer active.");
      if (call.status === "ACTIVE"
        && (call.metadata.phase === "ACTIVE"
          || (allowOpening && call.metadata.phase === "OPENING_SPEAKING"))
        && ["ANNOUNCED", "GRANTED"].includes(call.recordingConsentStatus)) return call;
      if (["ENDED", "TERMINATING", "HUMAN", "DECLINED_NOTICE"].includes(String(call.metadata.phase)))
        throw new Error("Realtime call is not authorized to stream.");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error("Realtime call opening timed out.");
  }

  async function start() {
    try {
      // Preconnect the model while Telnyx speaks the consented opening message.
      // No media is forwarded until the greeting ends; this removes model
      // handshake latency from the caller's first conversational response.
      const call = await waitUntilGreetingEnds(true);
      if (!open) return;
      openingMessage = typeof call.metadata.openingMessage === "string" && call.metadata.openingMessage.trim()
        ? call.metadata.openingMessage.trim().slice(0, 2000)
        : "How can I help you today?";
      // All audio captured before the complete opening is discarded.
      initialAudio.length = 0;
      initialBytes = 0;
      const claimedCall = await claimRealtimeStream(workspaceId, callId, streamId);
      if (!claimedCall) throw new Error("Realtime call stream already claimed.");
      claimed = true;
      const context = await realtimeSessionContext(workspaceId, call.conversationId);
      const { instructions } = context;
      priorConversation = context.history;
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
        // 512 audio/text tokens can cut a spoken answer mid-sentence; retain
        // a bounded per-turn limit, with existing call-level credit controls.
        max_output_tokens: 2048,
        audio: {
          input: { format: { type: "audio/pcmu" },
            // Near-field telephone microphone input needs filtering BEFORE
            // VAD to avoid background-noise barge-ins mid-assistant reply.
            noise_reduction: { type: "near_field" },
            turn_detection: { type: "semantic_vad", eagerness: "medium",
              create_response: true, interrupt_response: true } },
          output: { format: { type: "audio/pcmu" },
            voice: resolveVoiceProfile(
              typeof call.metadata.voiceProfile === "string" ? call.metadata.voiceProfile : "",
            ).realtimeVoiceId },
        },
        tools: context.tools, tool_choice: context.tools.length ? "auto" : "none",
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
      track(waitUntilGreetingEnds().then(() => {
        if (!open) return;
        // The webhook can lag the audio playback completion by one polling
        // interval. Keep only ~200ms of the newest buffered audio so the first
        // syllable after the greeting is not clipped, never the full greeting.
        while (initialAudio.length && initialBytes > 1600) {
          initialBytes -= initialAudio.shift()!.length;
        }
        speechAllowed = true;
        if (ready) {
          requestOpening();
          for (const frame of initialAudio) feedAudio(frame);
          initialAudio.length = 0;
          initialBytes = 0;
        }
      }).catch(err => {
        logger.warn({ err, workspaceId, callId }, "Realtime greeting authorization failed");
        fail("realtime-greeting-ended-abnormally");
      }));
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
    // Do not allow an unresponsive downstream booking or storage operation to
    // hold the media socket open forever after the carrier has disconnected.
    // Incomplete work must never be marked as clean billable usage.
    let pendingTimeout: NodeJS.Timeout | null = null;
    let drained = false;
    try {
      drained = await Promise.race([
        Promise.allSettled([...pendingWork]).then(() => true),
        new Promise<boolean>(resolve => {
          pendingTimeout = setTimeout(() => resolve(false), 3000);
        }),
      ]);
    } finally {
      if (pendingTimeout) clearTimeout(pendingTimeout);
    }
    if (!drained) {
      error = true;
      logger.error({ workspaceId, callId, pendingTasks: pendingWork.size },
        "Realtime session closed with unfinished provider or business work");
    }
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

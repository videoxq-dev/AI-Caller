import { createHash } from "node:crypto";
import { appendMessage, getConversationById } from "@/server/domain/core/repository";
import { logger } from "@/server/observability/logger";
import { responseOrchestrator } from "@/server/orchestrator";
import { resolveVoiceRuntime } from "@/server/providers/voice/runtime";
import { enqueueUniqueJobAt } from "@/server/jobs";
import { VOICE_RESPOND_TURN } from "@/server/jobs/queues";
import { getVoiceConfig } from "./config";
import {
  appendVoiceTranscriptSegment, claimVoiceTurn, finishVoiceTurn, restoreVoiceTurn,
  isVoiceTurnCurrent, yieldSupersededVoiceTurn,
} from "./repository";
import { estimateSpeechDurationMs, VOICE_TURN_SILENCE_MS } from "./turn-duration";
import { resolveVoiceProfile } from "./voices";

function commandId(seed: string) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function scheduleVoiceTurn(workspaceId: string, callId: string, eventId: string, reason = "final") {
  return enqueueUniqueJobAt(
    VOICE_RESPOND_TURN,
    `${callId}:${eventId}:${reason}`,
    { workspaceId, callId, eventId },
    new Date(Date.now() + VOICE_TURN_SILENCE_MS),
  );
}

/**
 * Runs in the durable background worker; the webhook only stores segments.
 * Outdated final chunks lose the token and cannot issue a speak command.
 */
export async function processVoiceTurn(input: { workspaceId: string; callId: string; eventId: string }) {
  const { workspaceId, callId, eventId } = input;
  const call = await claimVoiceTurn(workspaceId, callId, eventId);
  if (!call) return { status: "SKIPPED" as const };

  const startedAt = Date.now();
  try {
    if (!call.callControlId) throw new Error("Voice call is missing its Call Control ID.");
    if (!["ANNOUNCED", "GRANTED"].includes(call.recordingConsentStatus)) {
      await finishVoiceTurn(workspaceId, callId, eventId, "HUMAN");
      return { status: "SUPPRESSED" as const };
    }

    const result = await responseOrchestrator.respond(workspaceId, call.conversationId, {
      beforeTools: () => isVoiceTurnCurrent(workspaceId, callId, eventId),
    });
    const orchestrationMs = Date.now() - startedAt;

    // A later final chunk may arrive during the LLM or a tool finalizer.
    // Never queue an answer to the older partial request.
    const superseded = await yieldSupersededVoiceTurn(workspaceId, callId, eventId);
    if (superseded) {
      await scheduleVoiceTurn(workspaceId, callId, superseded, "superseded");
      return { status: "SUPERSEDED" as const };
    }

    if (!result.reply) {
      await finishVoiceTurn(workspaceId, callId, eventId, result.handlingMode === "HUMAN" ? "HUMAN" : "ACTIVE");
      return { status: "NO_REPLY" as const };
    }

    const conversation = await getConversationById(workspaceId, call.conversationId);
    // Issue-scoped escalation does not change conversation ownership. A
    // separate manual takeover may still race this turn and suppress speech.
    if (!conversation || conversation.handlingMode !== "AI") {
      await finishVoiceTurn(workspaceId, callId, eventId, "HUMAN");
      return { status: "HANDOFF" as const };
    }

    const voice = await getVoiceConfig(workspaceId);
    const profileKey = typeof call.metadata.voiceProfile === "string"
      ? call.metadata.voiceProfile : voice.config.profileKey;
    const language = typeof call.metadata.language === "string"
      ? call.metadata.language : voice.config.language;
    const speakingRate = typeof call.metadata.speakingRate === "number"
      ? call.metadata.speakingRate : voice.config.speakingRate;
    const runtime = await resolveVoiceRuntime(workspaceId, call.provider as "telnyx");
    const ready = await finishVoiceTurn(
      workspaceId, callId, eventId, "AI_SPEAKING", "ACTIVE",
    );
    if (!ready) {
      const newer = await yieldSupersededVoiceTurn(workspaceId, callId, eventId);
      if (newer) {
        await scheduleVoiceTurn(workspaceId, callId, newer, "pre-speak-superseded");
        return { status: "SUPERSEDED" as const };
      }
      return { status: "CALL_ENDED" as const };
    }

    await runtime.provider.speak({
      callControlId: call.callControlId,
      text: result.reply,
      voice: resolveVoiceProfile(profileKey).providerVoiceId,
      language,
      speakingRate,
      commandId: commandId(`${eventId}:reply`),
    });

    const startedMs = Math.max(0, Date.now() - call.startedAt.getTime());
    const endedMs = startedMs + estimateSpeechDurationMs(result.reply, speakingRate);
    const segment = await appendVoiceTranscriptSegment(workspaceId, call.id, {
      speaker: "AI",
      text: result.reply,
      startedMs,
      endedMs,
      externalEventId: `${eventId}:ai`,
    });
    await appendMessage(workspaceId, call.conversationId, {
      channel: "PHONE",
      direction: "OUTBOUND",
      senderType: "AI",
      contentType: "CALL_TRANSCRIPT",
      body: result.reply,
      provider: "telnyx-voice",
      externalMessageId: `${eventId}:ai`,
      status: "SENT",
      metadata: { voiceCallId: call.id, transcriptSegmentId: segment.id, voiceMode: call.mode, startedMs, endedMs },
    });
    logger.info({
      workspaceId, callId: call.id, transcriptionEventId: eventId,
      orchestrationMs, voiceTurnMs: Date.now() - startedAt,
      queueLagMs: call.metadata.pendingVoiceTurnAt
        ? Math.max(0, startedAt - new Date(String(call.metadata.pendingVoiceTurnAt)).getTime()) : null,
    }, "Voice AI reply accepted by telephony provider");
    return { status: "SPOKEN" as const };
  } catch (error) {
    const pending = await restoreVoiceTurn(workspaceId, callId, eventId);
    if (pending && pending !== eventId) {
      await scheduleVoiceTurn(workspaceId, callId, pending, "worker-recovery");
    }
    throw error;
  }
}

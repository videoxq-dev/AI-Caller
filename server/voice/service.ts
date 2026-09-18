import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { usageEvents } from "@/db/schema";
import { loadHostedRateSnapshot, quoteHostedUsage } from "@/server/billing/pricing";
import { chargeUnavoidableCredits } from "@/server/credits/service";
import {
  appendMessage,
  getConversationById,
  getOrCreateOpenConversation,
} from "@/server/domain/core/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { getBusinessSetup } from "@/server/domain/onboarding/repository";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { responseOrchestrator } from "@/server/orchestrator";
import type { NormalizedVoiceEvent, VoiceWebhookInput } from "@/server/providers/contracts";
import { isE2EProviderFixtureMode } from "@/server/providers/e2e-fixtures";
import { resolveVoiceRuntime, type VoiceProviderName, type VoiceRuntime } from "@/server/providers/voice/runtime";
import {
  claimProviderWebhookEvent,
  claimQueuedProviderWebhookEvent,
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
  markProviderWebhookQueued,
  releaseProviderWebhookEventForRetry,
} from "@/server/providers/webhooks/repository";
import { getVoiceConfig } from "./config";
import { buildVoiceGatewayStreamUrl } from "./gateway-auth";
import { resolveVoiceContact } from "./identity";
import { resolveInboundVoiceMode } from "./modes";
import {
  appendVoiceTranscriptSegment,
  createVoiceCall,
  getVoiceCallByExternalId,
  updateVoiceCall,
} from "./repository";
import { putVoiceRecording } from "./storage";
import { resolveVoiceProfile } from "./voices";

const MAX_VOICE_WEBHOOK_BYTES = 64 * 1024;
const MAX_RECORDING_BYTES = 50 * 1024 * 1024;
const DISCLOSURE_VERSION = "voice-recording-v1";

type VoiceOrchestratorResult = Awaited<ReturnType<typeof responseOrchestrator.respond>>;

type VoiceServiceDependencies = {
  resolveRuntime: (workspaceId: string, provider: VoiceProviderName) => Promise<VoiceRuntime>;
  respond: (workspaceId: string, conversationId: string) => Promise<VoiceOrchestratorResult>;
  fetchRecording: typeof fetch;
  putRecording: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
};

async function readWebhookBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_VOICE_WEBHOOK_BYTES) {
    throw new AppError("VOICE_WEBHOOK_TOO_LARGE", "Voice webhook payload is too large.", 413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_VOICE_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new AppError("VOICE_WEBHOOK_TOO_LARGE", "Voice webhook payload is too large.", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function deterministicCommandId(seed: string) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function phase(metadata: Record<string, unknown>) {
  return typeof metadata.phase === "string" ? metadata.phase : "UNKNOWN";
}

function estimateSpeechDurationMs(text: string, speakingRate = 1) {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const wordsPerSecond = 2.5 * Math.max(0.75, Math.min(1.25, speakingRate));
  return Math.max(400, Math.min(20_000, Math.round((words / wordsPerSecond) * 1000)));
}

function elapsedMs(startedAt: Date, occurredAt: Date | null) {
  const point = occurredAt ?? new Date();
  return Math.max(0, point.getTime() - startedAt.getTime());
}

function safeEventPayload(event: NormalizedVoiceEvent) {
  return {
    type: event.type,
    externalCallId: event.externalCallId,
    ...(event.type === "DTMF_GATHERED" ? { status: event.status } : {}),
    ...(event.type === "TRANSCRIPTION" ? { isFinal: event.isFinal } : {}),
    ...(event.type === "CALL_HANGUP" ? { cause: event.cause } : {}),
    ...(event.type === "RECORDING_SAVED" ? { recordingId: event.recordingId, format: event.format } : {}),
  };
}

function disclosureText(
  recordingPolicy: "ANNOUNCE" | "EXPLICIT_CONSENT",
  assistantName: string,
  businessName: string,
) {
  const identity = `Hi, I'm ${assistantName}, an AI assistant for ${businessName}.`;
  return recordingPolicy === "EXPLICIT_CONSENT"
    ? `${identity} This call may be recorded and transcribed to help with your request. Press 1 to agree, or press 2 to decline.`
    : `${identity} This call will be recorded and transcribed to help with your request.`;
}

function openingText(value: string | null) {
  return value?.trim() || "How can I help you today?";
}

function isPrivateIp(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("fc") || value.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(value)) return true;
    if (value.startsWith("::ffff:")) return isPrivateIp(value.slice("::ffff:".length));
  }
  return false;
}

async function assertSafeRecordingUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Provider recording URL credentials are not allowed.");
  const fixtureLocalhost = isE2EProviderFixtureMode() && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (fixtureLocalhost && url.protocol === "http:") return url;
  if (url.protocol !== "https:") throw new Error("Provider recording URL must use HTTPS.");

  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  if (!resolved.length || resolved.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Provider recording URL resolves to a private or unsafe network address.");
  }
  return url;
}

async function recordingBytes(initialUrl: string, fetcher: typeof fetch) {
  let current = await assertSafeRecordingUrl(initialUrl);
  let response: Response | null = null;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    response = await fetcher(current, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("Provider recording redirect is missing a destination.");
    current = await assertSafeRecordingUrl(new URL(location, current).toString());
  }
  if (!response || response.status >= 300 && response.status < 400) {
    throw new Error("Provider recording exceeded the redirect limit.");
  }
  if (!response.ok) throw new Error(`Unable to download call recording (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) {
    throw new Error("Call recording exceeds the maximum archive size.");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
  if (!["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(contentType)) {
    throw new Error("Provider recording returned an unsupported content type.");
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_RECORDING_BYTES) throw new Error("Call recording exceeds the maximum archive size.");
  return {
    bytes: buffer,
    contentType: contentType === "audio/mp3" ? "audio/mpeg" : contentType === "audio/x-wav" ? "audio/wav" : contentType,
  };
}

async function recordVoiceUsage(
  workspaceId: string,
  runtime: VoiceRuntime,
  call: NonNullable<Awaited<ReturnType<typeof getVoiceCallByExternalId>>>,
) {
  try {
    const durationSeconds = Math.max(0, call.durationSeconds ?? 0);
    let creditsCharged = 0;
    let providerCostMicros = 0;
    let billedUnits: Record<string, number> = {};
    let pricingDetails: Record<string, unknown> = {};

    if (runtime.mode === "HOSTED" && durationSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
      const rates = await loadHostedRateSnapshot({
        capability: "VOICE",
        provider: runtime.providerName,
        model: "",
        units: ["VOICE_MINUTE"],
      });
      const quote = quoteHostedUsage(rates, [{ unit: "VOICE_MINUTE", units: minutes }]);
      creditsCharged = quote.credits;
      providerCostMicros = quote.providerCostMicros;
      billedUnits = quote.billedUnits;
      pricingDetails = quote.pricingDetails;
      if (creditsCharged > 0) {
        await chargeUnavoidableCredits(workspaceId, creditsCharged, {
          reason: "Hosted inbound voice call",
          referenceType: "VOICE_CALL",
          referenceId: call.id,
        });
      }
    }

    await db.insert(usageEvents).values({
      workspaceId,
      capability: "VOICE",
      provider: call.provider,
      mode: runtime.mode,
      providerUsage: {
        durationSeconds,
        voiceMode: call.mode,
      },
      creditsCharged,
      providerCostMicros,
      billedUnits,
      pricingDetails,
      referenceType: "VOICE_CALL",
      referenceId: call.id,
    }).onConflictDoNothing();
  } catch (error) {
    logger.error({ err: error, workspaceId, callId: call.id }, "Failed to meter voice usage");
  }
}

export function createVoiceWebhookService(dependencies: VoiceServiceDependencies) {
  async function processEvent(
    workspaceId: string,
    runtime: VoiceRuntime,
    event: NormalizedVoiceEvent,
  ) {
    if (event.type === "CALL_INITIATED") {
      if (normalizePhone(event.to) !== runtime.receiverNumber) {
        throw new AppError("VOICE_DESTINATION_MISMATCH", "The inbound call destination does not match this workspace.", 409);
      }

      const contact = await resolveVoiceContact(workspaceId, event.from);
      const conversation = await getOrCreateOpenConversation(workspaceId, contact.id);
      const [mode, voice] = await Promise.all([
        resolveInboundVoiceMode(workspaceId, event.occurredAt ?? new Date()),
        getVoiceConfig(workspaceId),
      ]);
      const call = await createVoiceCall(workspaceId, {
        conversationId: conversation.id,
        contactId: contact.id,
        integrationId: runtime.integrationId,
        provider: runtime.providerName,
        externalCallId: event.externalCallId,
        callControlId: event.callControlId,
        fromNumber: normalizePhone(event.from),
        toNumber: normalizePhone(event.to),
        mode,
        recordingDisclosureVersion: DISCLOSURE_VERSION,
        metadata: {
          phase: "AWAITING_ANSWER",
          voiceProfile: voice.config.profileKey,
          language: voice.config.language,
          speakingRate: voice.config.speakingRate,
          recordingPolicy: voice.config.recordingPolicy,
        },
      });

      if (phase(call.metadata) === "AWAITING_ANSWER" && call.status === "RINGING") {
        await runtime.provider.answer({
          callControlId: event.callControlId,
          streamUrl: buildVoiceGatewayStreamUrl(workspaceId, call.id, event.externalCallId),
          commandId: deterministicCommandId(`${event.externalEventId}:answer`),
        });
      }
      return;
    }

    const call = await getVoiceCallByExternalId(workspaceId, runtime.providerName, event.externalCallId);
    if (!call) throw new AppError("VOICE_CALL_NOT_FOUND", "Voice call has not been initialized yet.", 409);

    if (event.type === "CALL_ANSWERED") {
      const voice = await getVoiceConfig(workspaceId);
      const business = await getBusinessSetup(workspaceId);
      const businessName = business.profile?.businessName?.trim() || "this business";
      const text = disclosureText(voice.config.recordingPolicy, voice.assistantName, businessName);

      if (phase(call.metadata) !== "AWAITING_ANSWER") return;

      if (voice.config.recordingPolicy === "EXPLICIT_CONSENT") {
        await runtime.provider.gatherConsent({
          callControlId: event.callControlId,
          text,
          voice: resolveVoiceProfile(voice.config.profileKey).providerVoiceId,
          language: voice.config.language,
          commandId: deterministicCommandId(`${event.externalEventId}:consent-gather`),
        });
        await updateVoiceCall(workspaceId, call.id, {
          status: "ACTIVE",
          answeredAt: event.occurredAt ?? new Date(),
          recordingDisclosedAt: event.occurredAt ?? new Date(),
        }, {
          phase: "AWAITING_RECORDING_CONSENT",
        });
        return;
      }

      await runtime.provider.speak({
        callControlId: event.callControlId,
        text,
        voice: resolveVoiceProfile(voice.config.profileKey).providerVoiceId,
        language: voice.config.language,
        speakingRate: voice.config.speakingRate,
        commandId: deterministicCommandId(`${event.externalEventId}:disclosure`),
      });
      await updateVoiceCall(workspaceId, call.id, {
        status: "ACTIVE",
        answeredAt: event.occurredAt ?? new Date(),
      }, { phase: "AWAITING_DISCLOSURE_END" });
      return;
    }

    if (event.type === "SPEAK_ENDED") {
      const currentPhase = phase(call.metadata);
      if (currentPhase === "DECLINED_NOTICE") {
        await runtime.provider.hangup({
          callControlId: event.callControlId,
          commandId: deterministicCommandId(`${event.externalEventId}:declined-hangup`),
        });
        await updateVoiceCall(workspaceId, call.id, {}, { phase: "TERMINATING" });
        return;
      }
      if (currentPhase !== "AWAITING_DISCLOSURE_END") return;

      const voice = await getVoiceConfig(workspaceId);
      await runtime.provider.startRecording({
        callControlId: event.callControlId,
        commandId: deterministicCommandId(`${event.externalEventId}:record`),
      });
      await runtime.provider.startTranscription({
        callControlId: event.callControlId,
        language: voice.config.language,
        commandId: deterministicCommandId(`${event.externalEventId}:transcription`),
      });
      await runtime.provider.speak({
        callControlId: event.callControlId,
        text: openingText(voice.openingMessage),
        voice: resolveVoiceProfile(voice.config.profileKey).providerVoiceId,
        language: voice.config.language,
        speakingRate: voice.config.speakingRate,
        commandId: deterministicCommandId(`${event.externalEventId}:opening`),
      });
      await updateVoiceCall(workspaceId, call.id, {
        recordingStatus: "RECORDING",
        recordingConsentStatus: "ANNOUNCED",
        recordingDisclosedAt: event.occurredAt ?? new Date(),
        transcriptStatus: "ACTIVE",
      }, { phase: "ACTIVE" });
      return;
    }

    if (event.type === "DTMF_GATHERED") {
      if (phase(call.metadata) !== "AWAITING_RECORDING_CONSENT") return;
      const voice = await getVoiceConfig(workspaceId);
      const profile = resolveVoiceProfile(voice.config.profileKey);
      const consentGranted = event.digits === "1" && event.status === "valid";

      if (consentGranted) {
        await runtime.provider.startRecording({
          callControlId: event.callControlId,
          commandId: deterministicCommandId(`${event.externalEventId}:record-after-consent`),
        });
        await runtime.provider.startTranscription({
          callControlId: event.callControlId,
          language: voice.config.language,
          commandId: deterministicCommandId(`${event.externalEventId}:transcription-after-consent`),
        });
        await runtime.provider.speak({
          callControlId: event.callControlId,
          text: openingText(voice.openingMessage),
          voice: profile.providerVoiceId,
          language: voice.config.language,
          speakingRate: voice.config.speakingRate,
          commandId: deterministicCommandId(`${event.externalEventId}:opening-after-consent`),
        });
        await updateVoiceCall(workspaceId, call.id, {
          recordingStatus: "RECORDING",
          recordingConsentStatus: "GRANTED",
          transcriptStatus: "ACTIVE",
        }, {
          phase: "ACTIVE",
          consentEvidence: "DTMF_1",
          consentEventId: event.externalEventId,
        });
        return;
      }

      await runtime.provider.speak({
        callControlId: event.callControlId,
        text: event.digits === "2"
          ? "No problem. I won't record or transcribe this call. Please contact the business by text or WhatsApp for assistance."
          : "I couldn't confirm permission to record and transcribe the call, so I'll end this call now. Please contact the business by text or WhatsApp for assistance.",
        voice: profile.providerVoiceId,
        language: voice.config.language,
        speakingRate: voice.config.speakingRate,
        commandId: deterministicCommandId(`${event.externalEventId}:declined-notice`),
      });
      await updateVoiceCall(workspaceId, call.id, {
        recordingStatus: "DECLINED",
        recordingConsentStatus: "DECLINED",
        transcriptStatus: "COMPLETE",
      }, {
        phase: "DECLINED_NOTICE",
        consentEvidence: event.digits === "2" ? "DTMF_2" : "NO_VALID_DTMF",
        consentEventId: event.externalEventId,
        consentGatherStatus: event.status,
      });
      return;
    }

    if (event.type === "TRANSCRIPTION") {
      if (!event.isFinal) return;
      const currentPhase = phase(call.metadata);
      const voice = await getVoiceConfig(workspaceId);

      if (currentPhase !== "ACTIVE") return;

      const endedMs = elapsedMs(call.startedAt, event.occurredAt);
      const startedMs = Math.max(0, endedMs - estimateSpeechDurationMs(event.transcript));
      const segment = await appendVoiceTranscriptSegment(workspaceId, call.id, {
        speaker: "CUSTOMER",
        text: event.transcript,
        startedMs,
        endedMs,
        confidence: event.confidence,
        externalEventId: event.externalEventId,
      });
      await appendMessage(workspaceId, call.conversationId, {
        channel: "PHONE",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        contentType: "CALL_TRANSCRIPT",
        body: event.transcript,
        provider: "telnyx-voice",
        externalMessageId: event.externalEventId,
        status: "RECEIVED",
        metadata: { voiceCallId: call.id, transcriptSegmentId: segment.id, voiceMode: call.mode, startedMs, endedMs },
      });

      const result = await dependencies.respond(workspaceId, call.conversationId);
      if (!result.reply) {
        await updateVoiceCall(workspaceId, call.id, {}, { phase: result.handlingMode === "HUMAN" ? "HUMAN" : "ACTIVE" });
        return;
      }

      const latestConversation = await getConversationById(workspaceId, call.conversationId);
      if (!latestConversation || latestConversation.handlingMode !== "AI") {
        await updateVoiceCall(workspaceId, call.id, {}, { phase: "HUMAN" });
        return;
      }

      const aiStartedMs = elapsedMs(call.startedAt, new Date());
      const aiEndedMs = aiStartedMs + estimateSpeechDurationMs(result.reply, voice.config.speakingRate);
      const aiSegment = await appendVoiceTranscriptSegment(workspaceId, call.id, {
        speaker: "AI",
        text: result.reply,
        startedMs: aiStartedMs,
        endedMs: aiEndedMs,
        externalEventId: `${event.externalEventId}:ai`,
      });
      await appendMessage(workspaceId, call.conversationId, {
        channel: "PHONE",
        direction: "OUTBOUND",
        senderType: "AI",
        contentType: "CALL_TRANSCRIPT",
        body: result.reply,
        provider: "telnyx-voice",
        externalMessageId: `${event.externalEventId}:ai`,
        status: "SENT",
        metadata: { voiceCallId: call.id, transcriptSegmentId: aiSegment.id, voiceMode: call.mode, startedMs: aiStartedMs, endedMs: aiEndedMs },
      });
      await runtime.provider.speak({
        callControlId: event.callControlId,
        text: result.reply,
        voice: resolveVoiceProfile(voice.config.profileKey).providerVoiceId,
        language: voice.config.language,
        speakingRate: voice.config.speakingRate,
        commandId: deterministicCommandId(`${event.externalEventId}:reply`),
      });
      if (result.handlingMode === "HUMAN") {
        await updateVoiceCall(workspaceId, call.id, {}, { phase: "HUMAN" });
      }
      return;
    }

    if (event.type === "RECORDING_SAVED") {
      const archived = await recordingBytes(event.recordingUrl, dependencies.fetchRecording);
      const key = `workspaces/${workspaceId}/voice/${call.id}/recording.${event.format}`;
      await dependencies.putRecording(key, archived.bytes, archived.contentType);
      const durationSeconds = event.startedAt && event.endedAt
        ? Math.max(0, Math.round((event.endedAt.getTime() - event.startedAt.getTime()) / 1000))
        : call.durationSeconds;
      await updateVoiceCall(workspaceId, call.id, {
        recordingStatus: "AVAILABLE",
        recordingExternalId: event.recordingId,
        recordingObjectKey: key,
        recordingMimeType: archived.contentType,
        recordingDurationSeconds: durationSeconds ?? null,
      });
      await appendMessage(workspaceId, call.conversationId, {
        channel: "PHONE",
        direction: "INBOUND",
        senderType: "SYSTEM",
        contentType: "CALL_RECORDING",
        body: "Incoming call recording",
        provider: "telnyx-voice",
        externalMessageId: `recording:${event.recordingId ?? event.externalEventId}`,
        status: "AVAILABLE",
        metadata: {
          voiceCallId: call.id,
          durationSeconds: durationSeconds ?? null,
          voiceMode: call.mode,
        },
      });
      return;
    }

    if (event.type === "RECORDING_FAILED") {
      await updateVoiceCall(workspaceId, call.id, { recordingStatus: "FAILED" }, {
        recordingError: event.error,
      });
      return;
    }

    if (event.type === "CALL_HANGUP") {
      const endedAt = event.occurredAt ?? new Date();
      const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000));
      const updated = await updateVoiceCall(workspaceId, call.id, {
        status: "COMPLETED",
        endedAt,
        durationSeconds,
        transcriptStatus: call.transcriptStatus === "FAILED" ? "FAILED" : "COMPLETE",
      }, {
        phase: "ENDED",
        hangupCause: event.cause,
      });
      await recordVoiceUsage(workspaceId, runtime, updated);
    }
  }

  return {
    async ingest(request: Request, workspaceId: string, providerName: VoiceProviderName) {
      const rawBody = await readWebhookBody(request);
      const runtime = await dependencies.resolveRuntime(workspaceId, providerName);
      const input: VoiceWebhookInput = { request, rawBody };
      if (!(await runtime.provider.verifyWebhook(input))) {
        throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Invalid voice webhook signature.", 401);
      }
      if (runtime.mode === "HOSTED" && runtime.serviceStatus === "SUSPENDED") {
        return { ok: true as const, processed: 0, duplicates: 0, failed: 0, suppressed: 1 };
      }
      const events = await runtime.provider.normalizeWebhook(input);
      let processed = 0;
      let duplicates = 0;
      let failed = 0;

      for (const event of events) {
        const payload = safeEventPayload(event);
        const claim = await claimProviderWebhookEvent(workspaceId, {
          provider: `${providerName}-voice`,
          externalEventId: event.externalEventId,
          payload,
        });
        if (claim.status === "PROCESSED" || claim.status === "FAILED" || claim.status === "PROCESSING") {
          duplicates += 1;
          continue;
        }

        if (claim.status === "RECEIVED") {
          const queued = await markProviderWebhookQueued(workspaceId, claim.eventId, payload);
          if (!queued) {
            duplicates += 1;
            continue;
          }
        }

        const processing = await claimQueuedProviderWebhookEvent(workspaceId, claim.eventId);
        if (!processing) {
          duplicates += 1;
          continue;
        }

        let failClosed = false;
        try {
          if (event.type === "TRANSCRIPTION" && event.isFinal) failClosed = phase(
            (await getVoiceCallByExternalId(workspaceId, runtime.providerName, event.externalCallId))?.metadata ?? {},
          ) === "ACTIVE";
          await processEvent(workspaceId, runtime, event);
          await completeProviderWebhookEvent(workspaceId, claim.eventId);
          processed += 1;
        } catch (error) {
          if (failClosed) {
            await failProviderWebhookEvent(workspaceId, claim.eventId, error);
            logger.error({ err: error, workspaceId, eventType: event.type, eventId: event.externalEventId }, "Voice event failed closed after orchestration began");
            failed += 1;
            continue;
          }
          await releaseProviderWebhookEventForRetry(workspaceId, claim.eventId, error);
          throw error;
        }
      }

      return { ok: true as const, processed, duplicates, failed };
    },
  };
}

export const voiceWebhookService = createVoiceWebhookService({
  resolveRuntime: resolveVoiceRuntime,
  respond: (workspaceId, conversationId) => responseOrchestrator.respond(workspaceId, conversationId),
  fetchRecording: fetch,
  putRecording: putVoiceRecording,
});

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { usageEvents, voiceCalls, voiceRealtimeResponseUsage } from "@/db/schema";
import { chargeUnavoidableCredits } from "@/server/credits/service";
import { logger } from "@/server/observability/logger";
import { getVoiceCall, updateVoiceCall } from "./repository";
import { quoteRealtimeVoiceFromRates, type RealtimeVoiceModel, type RealtimeVoiceUsage } from "@/server/billing/realtime-voice";
import type { HostedRate } from "@/server/billing/pricing";

export const EMPTY_REALTIME_USAGE: RealtimeVoiceUsage = {
  audioInputTokens: 0, audioCachedInputTokens: 0, audioOutputTokens: 0,
  textInputTokens: 0, textCachedInputTokens: 0, textOutputTokens: 0,
};

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Realtime provider usage counter.");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Parse authoritative OpenAI response.done.usage; cached subsets are NOT added twice. */
export function normalizeRealtimeResponseUsage(value: unknown): RealtimeVoiceUsage {
  const usage = object(value);
  if (Object.keys(usage).length === 0) throw new Error("Realtime response usage is missing.");
  const input = object(usage.input_token_details);
  const cached = object(input.cached_tokens_details);
  const output = object(usage.output_token_details);
  const audioInputTokens = safeCount(input.audio_tokens);
  const textInputTokens = safeCount(input.text_tokens);
  const audioCachedInputTokens = safeCount(cached.audio_tokens);
  const textCachedInputTokens = safeCount(cached.text_tokens);
  const audioOutputTokens = safeCount(output.audio_tokens);
  const textOutputTokens = safeCount(output.text_tokens);
  if (audioCachedInputTokens > audioInputTokens || textCachedInputTokens > textInputTokens) {
    throw new Error("Realtime provider usage has impossible cached token counts.");
  }
  if (safeCount(usage.input_tokens) !== audioInputTokens + textInputTokens
    || safeCount(usage.output_tokens) !== audioOutputTokens + textOutputTokens) {
    throw new Error("Realtime response has unallocated input/output tokens; billing requires authoritative details.");
  }
  return { audioInputTokens, audioCachedInputTokens, audioOutputTokens,
    textInputTokens, textCachedInputTokens, textOutputTokens };
}

export async function recordRealtimeResponse(workspaceId: string, callId: string,
  responseId: string, rawUsage: unknown) {
  if (!responseId || responseId.length > 255) throw new Error("Missing Realtime response ID.");
  const usage = normalizeRealtimeResponseUsage(rawUsage);
  await db.insert(voiceRealtimeResponseUsage).values({
    workspaceId, voiceCallId: callId, responseId, usage,
  }).onConflictDoNothing();
}

export async function markRealtimeSessionClosed(workspaceId: string, callId: string, confirmed: boolean) {
  const call = await getVoiceCall(workspaceId, callId);
  if (!call || call.metadata.voiceTechnology !== "REALTIME") return;
  // Do not overwrite a failed close with a successful one from a stale stream.
  if (call.metadata.realtimeUsageComplete === false) return;
  await updateVoiceCall(workspaceId, callId, {}, {
    realtimeUsageComplete: confirmed,
    realtimeClosedAt: new Date().toISOString(),
  });
  if (confirmed) await settleRealtimeCall(workspaceId, callId);
}

function sumUsage(rows: Array<{ usage: Record<string, number> }>): RealtimeVoiceUsage {
  const total = { ...EMPTY_REALTIME_USAGE };
  for (const { usage } of rows) for (const key of Object.keys(total) as Array<keyof RealtimeVoiceUsage>) {
    const next = total[key] + safeCount(usage[key]);
    if (!Number.isSafeInteger(next)) throw new Error("Realtime usage aggregate overflow.");
    total[key] = next;
  }
  return total;
}

function readSnapshot(value: unknown): HostedRate[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Realtime call is missing its immutable rate snapshot.");
  return value.map(v => {
    const rate = object(v);
    if (typeof rate.unit !== "string" || typeof rate.id !== "string") throw new Error("Corrupt Realtime rate snapshot.");
    const at = new Date(String(rate.effectiveFrom));
    if (Number.isNaN(at.getTime())) throw new Error("Invalid Realtime rate effective date.");
    return {
      id: rate.id,
      unit: rate.unit as HostedRate["unit"],
      costMicros: safeCount(rate.costMicros),
      unitsPerCost: safeCount(rate.unitsPerCost),
      targetMarginBps: safeCount(rate.targetMarginBps),
      provider: String(rate.provider),
      model: String(rate.model),
      effectiveFrom: at,
    };
  });
}

/** Called after BOTH Telnyx hangup and a clean OpenAI usage stream close, in either order. */
export async function settleRealtimeCall(workspaceId: string, callId: string) {
  const call = await getVoiceCall(workspaceId, callId);
  if (!call || call.metadata.voiceTechnology !== "REALTIME" || call.status !== "COMPLETED"
    || call.metadata.realtimeUsageComplete !== true) return { settled: false };
  const [prior] = await db.select({ id: usageEvents.id }).from(usageEvents).where(and(
    eq(usageEvents.workspaceId, workspaceId),
    eq(usageEvents.referenceType, "VOICE_CALL"), eq(usageEvents.referenceId, callId),
  )).limit(1);
  if (prior) return { settled: true };
  const model = call.metadata.realtimeModel as RealtimeVoiceModel;
  if (!["gpt-realtime-2.1", "gpt-realtime-2.1-mini"].includes(model)) throw new Error("Invalid per-call Realtime model.");
  const snapshots = object(call.metadata.realtimeRates);
  const aiRates = readSnapshot(snapshots.openaiRates);
  const telnyxRates = readSnapshot(snapshots.telnyxRates);
  const rows = await db.select({ usage: voiceRealtimeResponseUsage.usage })
    .from(voiceRealtimeResponseUsage).where(and(
      eq(voiceRealtimeResponseUsage.workspaceId, workspaceId),
      eq(voiceRealtimeResponseUsage.voiceCallId, callId),
    ));
  const quote = quoteRealtimeVoiceFromRates({
    model,
    numberType: "local",
    callSeconds: Math.max(0, call.durationSeconds ?? 0),
    recorded: call.recordingConsentStatus === "ANNOUNCED" || call.recordingConsentStatus === "GRANTED",
    usage: sumUsage(rows),
  }, aiRates, telnyxRates);
  // Idempotent wallet ledger and unique VOICE_CALL usage reference make retries safe.
  if (quote.credits > 0) {
    await chargeUnavoidableCredits(workspaceId, quote.credits, {
      reason: "Hosted Realtime inbound voice call",
      referenceType: "VOICE_CALL", referenceId: call.id,
    });
  }
  await db.insert(usageEvents).values({
    workspaceId, capability: "VOICE", provider: call.provider, mode: "HOSTED",
    providerUsage: { ...quote.billedUnits, model, technology: "REALTIME",
      durationSeconds: call.durationSeconds ?? 0, voiceMode: call.mode },
    creditsCharged: quote.credits, providerCostMicros: quote.providerCostMicros,
    billedUnits: quote.billedUnits, pricingDetails: quote.pricingDetails,
    referenceType: "VOICE_CALL", referenceId: call.id,
  }).onConflictDoNothing();
  logger.info({ workspaceId, callId: call.id, creditsCharged: quote.credits,
    providerCostMicros: quote.providerCostMicros }, "Realtime voice usage settled");
  return { settled: true, quote };
}

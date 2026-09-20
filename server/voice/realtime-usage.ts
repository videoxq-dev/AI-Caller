import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { usageEvents, voiceRealtimeResponseUsage } from "@/db/schema";
import { settleCreditReservation } from "@/server/credits/service";
import { logger } from "@/server/observability/logger";
import { getVoiceCall } from "./repository";
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
function optionalCount(value: unknown): number { return value == null ? 0 : safeCount(value); }

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
  const audioInputTokens = optionalCount(input.audio_tokens);
  const textInputTokens = optionalCount(input.text_tokens);
  const audioCachedInputTokens = optionalCount(cached.audio_tokens);
  const textCachedInputTokens = optionalCount(cached.text_tokens);
  const audioOutputTokens = optionalCount(output.audio_tokens);
  const textOutputTokens = optionalCount(output.text_tokens);
  if (safeCount(usage.input_tokens) !== audioInputTokens + textInputTokens
    || safeCount(usage.output_tokens) !== audioOutputTokens + textOutputTokens
    || optionalCount(input.image_tokens) > 0
    || optionalCount(cached.image_tokens) > 0
    || optionalCount(input.cached_tokens) !== audioCachedInputTokens + textCachedInputTokens) {
    throw new Error("Realtime provider usage contains unpriced or inconsistent token totals.");
  }
  if (audioCachedInputTokens > audioInputTokens || textCachedInputTokens > textInputTokens) {
    throw new Error("Realtime provider usage has impossible cached token counts.");
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

/**
 * Check a live call's accumulated provider usage against its prefunded hold.
 * This is a soft cutoff: an individual in-flight response can exceed the hold;
 * the final ledger still charges the authoritative invoice-sized usage.
 */
export async function realtimeCreditBudgetReached(workspaceId: string, callId: string,
  now = new Date(), maxCreditFraction = 0.9) {
  const call = await getVoiceCall(workspaceId, callId);
  if (!call || call.metadata.voiceTechnology !== "REALTIME" || call.status !== "ACTIVE")
    return true;
  const model = call.metadata.realtimeModel as RealtimeVoiceModel;
  if (model !== "gpt-realtime-2.1" && model !== "gpt-realtime-2.1-mini")
    throw new Error("Invalid Realtime budget model.");
  const snapshot = object(call.metadata.realtimeRates);
  const rows = await db.select({ usage: voiceRealtimeResponseUsage.usage })
    .from(voiceRealtimeResponseUsage).where(and(
      eq(voiceRealtimeResponseUsage.workspaceId, workspaceId),
      eq(voiceRealtimeResponseUsage.voiceCallId, callId),
    ));
  const seconds = Math.max(0, Math.ceil((now.getTime()
    - (call.answeredAt ?? call.startedAt).getTime()) / 1000));
  const quote = quoteRealtimeVoiceFromRates({
    model, callSeconds: seconds, numberType: "local",
    recorded: call.recordingConsentStatus === "ANNOUNCED"
      || call.recordingConsentStatus === "GRANTED",
    ttsCharacters: typeof call.metadata.voiceTelnyxTtsCharacters === "number"
      ? call.metadata.voiceTelnyxTtsCharacters : 0,
    usage: sumUsage(rows),
  }, readSnapshot(snapshot.openaiRates), readSnapshot(snapshot.telnyxRates));
  const hold = call.metadata.realtimeReservationAmount;
  const creditLimit = typeof hold === "number" && Number.isSafeInteger(hold) && hold > 0
    ? Math.floor(hold * maxCreditFraction) : 450;
  return quote.credits >= creditLimit;
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
  // The reservation is written before issuing the Telnyx answer. Fail closed
  // if a newer call somehow reached settlement without its funded hold.
  if (typeof call.metadata.realtimeReservationId !== "string") {
    throw new Error("Realtime call cannot settle without the original credit reservation.");
  }
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
    ttsCharacters: typeof call.metadata.voiceTelnyxTtsCharacters === "number"
      ? call.metadata.voiceTelnyxTtsCharacters : 0,
    usage: sumUsage(rows),
  }, aiRates, telnyxRates);
  // Settle the original held credits instead of releasing them at hangup
  // and separately debiting a mutable balance. The ledger reference is unique.
  const charge = {
    reason: "Hosted Realtime inbound voice call",
    referenceType: "VOICE_CALL", referenceId: call.id,
  };
  const reservationId = call.metadata.realtimeReservationId;
  await settleCreditReservation(workspaceId, reservationId as string, quote.credits, charge);
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

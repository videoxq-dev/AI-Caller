import { AppError } from "@/server/http/errors";
import { loadHostedRateSnapshot, quoteHostedUsage, type HostedPricingUnit, type HostedRate, type UsageLine } from "./pricing";

export const REALTIME_VOICE_MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;
export type RealtimeVoiceModel = typeof REALTIME_VOICE_MODELS[number];

// Unlike the existing hosted rate cards' 50% gross margin, realtime is
// explicitly priced at the requested 50% MARKUP (retail = cost * 1.5).
export const REALTIME_VOICE_MARKUP_BPS = 5000;
export const REALTIME_VOICE_CREDIT_VALUE_MICROS = 1000;

const openAiUnits = [
  "VOICE_REALTIME_AUDIO_INPUT_TOKEN",
  "VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN",
  "VOICE_REALTIME_AUDIO_OUTPUT_TOKEN",
  "VOICE_REALTIME_TEXT_INPUT_TOKEN",
  "VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN",
  "VOICE_REALTIME_TEXT_OUTPUT_TOKEN",
] as const satisfies readonly HostedPricingUnit[];

const telnyxUnits = [
  "VOICE_REALTIME_CARRIER_MINUTE",
  "VOICE_REALTIME_STREAM_MINUTE",
  "VOICE_REALTIME_RECORDING_MINUTE",
  "VOICE_REALTIME_TRANSCRIPTION_MINUTE",
  "VOICE_REALTIME_GREETING_TTS_CHAR",
] as const satisfies readonly HostedPricingUnit[];

export type RealtimeVoiceUsage = {
  // OpenAI input token totals INCLUDE the cached input token subsets.
  // Do not bill cached tokens twice.
  audioInputTokens: number;
  audioCachedInputTokens: number;
  audioOutputTokens: number;
  textInputTokens: number;
  textCachedInputTokens: number;
  textOutputTokens: number;
};

export type RealtimeVoiceBill = {
  model: RealtimeVoiceModel;
  callSeconds: number;
  recorded: boolean;
  numberType: "local";
  usage: RealtimeVoiceUsage;
};

function integer(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("INVALID_REALTIME_USAGE", `${field} must be a non-negative safe integer.`, 422);
  }
  return value;
}

function ceilDiv(left: bigint, right: bigint) {
  return (left + right - BigInt(1)) / right;
}

function safeNumber(value: bigint, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range.`);
  return number;
}

export function quoteRealtimeVoiceFromRates(
  input: RealtimeVoiceBill,
  openaiRates: HostedRate[],
  telnyxRates: HostedRate[],
) {
  if (!REALTIME_VOICE_MODELS.includes(input.model)) {
    throw new AppError("REALTIME_MODEL_NOT_SUPPORTED", "Realtime voice model is not supported.", 422);
  }
  if (input.numberType !== "local") {
    throw new AppError("REALTIME_NUMBER_RATE_NOT_CONFIGURED", "Realtime voice currently requires a US local-number rate.", 422);
  }
  const seconds = integer(input.callSeconds, "callSeconds");
  const usage = input.usage;
  for (const [field, value] of Object.entries(usage)) integer(value, field);
  if (usage.audioCachedInputTokens > usage.audioInputTokens
    || usage.textCachedInputTokens > usage.textInputTokens) {
    throw new AppError("INVALID_REALTIME_USAGE", "Cached input tokens cannot exceed total input tokens.", 422);
  }
  const minutes = Math.ceil(seconds / 60);
  const openaiLines: UsageLine[] = [
    { unit: "VOICE_REALTIME_AUDIO_INPUT_TOKEN", units: usage.audioInputTokens - usage.audioCachedInputTokens },
    { unit: "VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN", units: usage.audioCachedInputTokens },
    { unit: "VOICE_REALTIME_AUDIO_OUTPUT_TOKEN", units: usage.audioOutputTokens },
    { unit: "VOICE_REALTIME_TEXT_INPUT_TOKEN", units: usage.textInputTokens - usage.textCachedInputTokens },
    { unit: "VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN", units: usage.textCachedInputTokens },
    { unit: "VOICE_REALTIME_TEXT_OUTPUT_TOKEN", units: usage.textOutputTokens },
  ];
  const telnyxLines: UsageLine[] = [
    { unit: "VOICE_REALTIME_CARRIER_MINUTE", units: minutes },
    { unit: "VOICE_REALTIME_STREAM_MINUTE", units: minutes },
    { unit: "VOICE_REALTIME_RECORDING_MINUTE", units: input.recorded ? minutes : 0 },
    { unit: "VOICE_REALTIME_TRANSCRIPTION_MINUTE", units: minutes },
  ];

  // Use versioned admin rate cards solely to calculate provider cost.
  // Legacy gross-margin settings must never be applied to this separate 50%-markup product.
  const aiQuote = quoteHostedUsage(openaiRates.map((rate) => ({ ...rate, targetMarginBps: 0 })), openaiLines);
  const carrierQuote = quoteHostedUsage(telnyxRates.map((rate) => ({ ...rate, targetMarginBps: 0 })), telnyxLines);
  const costMicros = BigInt(aiQuote.providerCostMicros) + BigInt(carrierQuote.providerCostMicros);
  const retailMicros = ceilDiv(costMicros * BigInt(10_000 + REALTIME_VOICE_MARKUP_BPS), BigInt(10_000));
  const credits = ceilDiv(retailMicros, BigInt(REALTIME_VOICE_CREDIT_VALUE_MICROS));

  return {
    providerCostMicros: safeNumber(costMicros, "Provider cost"),
    retailMicros: safeNumber(retailMicros, "Retail value"),
    credits: safeNumber(credits, "Credit charge"),
    billedUnits: { ...aiQuote.billedUnits, ...carrierQuote.billedUnits },
    pricingDetails: {
      currency: "USD",
      model: input.model,
      numberType: input.numberType,
      callSeconds: seconds,
      recorded: input.recorded,
      markupBps: REALTIME_VOICE_MARKUP_BPS,
      creditValueMicros: REALTIME_VOICE_CREDIT_VALUE_MICROS,
      openaiProviderCostMicros: aiQuote.providerCostMicros,
      telnyxProviderCostMicros: carrierQuote.providerCostMicros,
      rates: [...aiQuote.pricingDetails.rates, ...carrierQuote.pricingDetails.rates],
    },
  };
}

export async function loadRealtimeRateSnapshots(model: RealtimeVoiceModel, at = new Date()) {
  if (!REALTIME_VOICE_MODELS.includes(model)) {
    throw new AppError("REALTIME_MODEL_NOT_SUPPORTED", "Realtime voice model is not supported.", 422);
  }
  const [openaiRates, telnyxRates] = await Promise.all([
    loadHostedRateSnapshot({
      capability: "VOICE", provider: "openai", model, units: [...openAiUnits], at,
    }),
    loadHostedRateSnapshot({
      capability: "VOICE", provider: "telnyx", model: "realtime-us-local", units: [...telnyxUnits], at,
    }),
  ]);
  return { openaiRates, telnyxRates };
}

export async function quoteRealtimeVoice(input: RealtimeVoiceBill, at = new Date()) {
  if (!REALTIME_VOICE_MODELS.includes(input.model)) {
    throw new AppError("REALTIME_MODEL_NOT_SUPPORTED", "Realtime voice model is not supported.", 422);
  }
  if (input.numberType !== "local") {
    throw new AppError("REALTIME_NUMBER_RATE_NOT_CONFIGURED", "Realtime voice currently requires a US local-number rate.", 422);
  }
  const { openaiRates, telnyxRates } = await loadRealtimeRateSnapshots(input.model, at);
  return quoteRealtimeVoiceFromRates(input, openaiRates, telnyxRates);
}

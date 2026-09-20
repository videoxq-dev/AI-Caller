import { describe, expect, it } from "vitest";
import type { HostedRate, HostedPricingUnit } from "./pricing";
import {
  quoteRealtimeVoiceFromRates, type RealtimeVoiceBill, type RealtimeVoiceModel,
} from "./realtime-voice";

const date = new Date("2026-09-20T00:00:00Z");
const openai: Record<RealtimeVoiceModel, number[]> = {
  "gpt-realtime-2.1": [32000000, 400000, 64000000, 4000000, 400000, 24000000],
  "gpt-realtime-2.1-mini": [10000000, 300000, 20000000, 600000, 60000, 2400000],
};
const aiUnits: HostedPricingUnit[] = [
  "VOICE_REALTIME_AUDIO_INPUT_TOKEN",
  "VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN",
  "VOICE_REALTIME_AUDIO_OUTPUT_TOKEN",
  "VOICE_REALTIME_TEXT_INPUT_TOKEN",
  "VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN",
  "VOICE_REALTIME_TEXT_OUTPUT_TOKEN",
];
const telnyxUnits: HostedPricingUnit[] = [
  "VOICE_REALTIME_CARRIER_MINUTE",
  "VOICE_REALTIME_STREAM_MINUTE",
  "VOICE_REALTIME_RECORDING_MINUTE",
  "VOICE_REALTIME_TRANSCRIPTION_MINUTE",
  "VOICE_REALTIME_GREETING_TTS_CHAR",
];
function rate(model: string, unit: HostedPricingUnit, micros: number, unitsPerCost: number): HostedRate {
  return {
    id: `${model}:${unit}`, unit, costMicros: micros, unitsPerCost,
    targetMarginBps: 5000, provider: model.startsWith("gpt-") ? "openai" : "telnyx",
    model, effectiveFrom: date,
  };
}
function rates(model: RealtimeVoiceModel) {
  return {
    ai: aiUnits.map((unit, i) => rate(model, unit, openai[model][i], 1_000_000)),
    telnyx: telnyxUnits.map((unit, i) => rate("realtime-us-local", unit, [5200, 3500, 2000, 15000][i], 1)),
  };
}
const usage: RealtimeVoiceBill["usage"] = {
  audioInputTokens: 300,
  audioCachedInputTokens: 0,
  audioOutputTokens: 600,
  textInputTokens: 2000,
  textCachedInputTokens: 0,
  textOutputTokens: 200,
};
function sample(model: RealtimeVoiceModel, overrides: Partial<RealtimeVoiceBill> = {}): RealtimeVoiceBill {
  return {
    model, numberType: "local", callSeconds: 60, recorded: true, usage,
    ...overrides,
  };
}

describe("realtime voice pricing / 50% cost markup", () => {
  it("quotes full Realtime for metered audio, text and three local carrier components", () => {
    const r = rates("gpt-realtime-2.1");
    const q = quoteRealtimeVoiceFromRates(sample("gpt-realtime-2.1"), r.ai, r.telnyx);
    expect(q.pricingDetails.openaiProviderCostMicros).toBe(60800);
    expect(q.pricingDetails.telnyxProviderCostMicros).toBe(25700);
    expect(q.providerCostMicros).toBe(86500);
    expect(q.retailMicros).toBe(129750);
    expect(q.credits).toBe(130);
    expect(q.pricingDetails.markupBps).toBe(5000);
  });

  it("quotes mini independently without changing the existing legacy voice rate", () => {
    const r = rates("gpt-realtime-2.1-mini");
    const q = quoteRealtimeVoiceFromRates(sample("gpt-realtime-2.1-mini"), r.ai, r.telnyx);
    expect(q.pricingDetails.openaiProviderCostMicros).toBe(16680);
    expect(q.providerCostMicros).toBe(42380);
    expect(q.retailMicros).toBe(63570);
    expect(q.credits).toBe(64);
  });

  it("bills cached audio and cached text subsets at their cached rates exactly once", () => {
    const r = rates("gpt-realtime-2.1-mini");
    const q = quoteRealtimeVoiceFromRates(sample("gpt-realtime-2.1-mini", {
      usage: { ...usage, audioCachedInputTokens: 100, textCachedInputTokens: 500 },
    }), r.ai, r.telnyx);
    expect(q.billedUnits.VOICE_REALTIME_AUDIO_INPUT_TOKEN).toBe(200);
    expect(q.billedUnits.VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN).toBe(100);
    expect(q.billedUnits.VOICE_REALTIME_TEXT_INPUT_TOKEN).toBe(1500);
    expect(q.billedUnits.VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN).toBe(500);
    expect(q.providerCostMicros).toBe(41140);
    expect(q.credits).toBe(62);
  });

  it("charges started carrier minutes and omits recording cost when declined", () => {
    const r = rates("gpt-realtime-2.1-mini");
    const q = quoteRealtimeVoiceFromRates(sample("gpt-realtime-2.1-mini", {
      callSeconds: 61, recorded: false,
    }), r.ai, r.telnyx);
    expect(q.billedUnits.VOICE_REALTIME_CARRIER_MINUTE).toBe(2);
    expect(q.billedUnits.VOICE_REALTIME_STREAM_MINUTE).toBe(2);
    expect(q.billedUnits.VOICE_REALTIME_RECORDING_MINUTE).toBeUndefined();
    expect(q.providerCostMicros).toBe(64080);
    expect(q.credits).toBe(97);
  });

  it("rejects impossible cached usage and unsupported number types", () => {
    const r = rates("gpt-realtime-2.1");
    expect(() => quoteRealtimeVoiceFromRates(sample("gpt-realtime-2.1", {
      usage: { ...usage, audioCachedInputTokens: 301 },
    }), r.ai, r.telnyx)).toThrow();
    expect(() => quoteRealtimeVoiceFromRates(sample("gpt-realtime-2.1", {
      callSeconds: -1,
    }), r.ai, r.telnyx)).toThrow();
    expect(() => quoteRealtimeVoiceFromRates({
      ...sample("gpt-realtime-2.1"), numberType: "toll_free" as "local",
    }, r.ai, r.telnyx)).toThrow();
  });

  it("fails closed without a carrier rate rather than charging only AI tokens", () => {
    const r = rates("gpt-realtime-2.1");
    expect(() => quoteRealtimeVoiceFromRates(
      sample("gpt-realtime-2.1"), r.ai, r.telnyx.slice(0, 1),
    )).toThrow("Missing hosted rate");
  });
});

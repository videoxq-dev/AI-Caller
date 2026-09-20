import { describe, expect, it } from "vitest";
import { normalizeRealtimeResponseUsage } from "./realtime-usage";

const sample = {
  input_tokens: 132,
  output_tokens: 121,
  input_token_details: {
    text_tokens: 119, audio_tokens: 13, cached_tokens: 64,
    cached_tokens_details: { text_tokens: 64, audio_tokens: 0 },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 91 },
};

describe("authoritative OpenAI Realtime response usage", () => {
  it("keeps the cached subset separate and accounts for all input/output tokens", () => {
    expect(normalizeRealtimeResponseUsage(sample)).toEqual({
      audioInputTokens: 13, audioCachedInputTokens: 0,
      audioOutputTokens: 91, textInputTokens: 119,
      textCachedInputTokens: 64, textOutputTokens: 30,
    });
  });

  it("defaults optional zero audio or text subtotals, not missing total counters", () => {
    expect(normalizeRealtimeResponseUsage({
      input_tokens: 2, output_tokens: 0,
      input_token_details: { text_tokens: 2, cached_tokens: 0 },
      output_token_details: {},
    })).toEqual({
      audioInputTokens: 0, audioCachedInputTokens: 0,
      audioOutputTokens: 0, textInputTokens: 2,
      textCachedInputTokens: 0, textOutputTokens: 0,
    });
  });

  it("rejects missing total counters, unsupported image use and inconsistent cached counts", () => {
    expect(() => normalizeRealtimeResponseUsage({
      ...sample, input_tokens: undefined,
    })).toThrow();
    expect(() => normalizeRealtimeResponseUsage({
      ...sample, input_token_details: {
        ...sample.input_token_details, image_tokens: 10,
      },
    })).toThrow();
    expect(() => normalizeRealtimeResponseUsage({
      ...sample, input_token_details: {
        ...sample.input_token_details, cached_tokens: 70,
      },
    })).toThrow();
    expect(() => normalizeRealtimeResponseUsage({
      ...sample, input_token_details: {
        ...sample.input_token_details,
        cached_tokens_details: { audio_tokens: 50, text_tokens: 64 },
      },
    })).toThrow();
  });
});

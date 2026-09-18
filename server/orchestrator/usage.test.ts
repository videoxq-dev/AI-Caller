import { describe, expect, it } from "vitest";
import { normalizeAIProviderUsage } from "./usage";

describe("AI provider usage normalization", () => {
  it("normalizes OpenAI Responses usage including cached input", () => {
    expect(normalizeAIProviderUsage({
      usage: {
        input_tokens: 3000,
        input_tokens_details: { cached_tokens: 300 },
        output_tokens: 250,
        total_tokens: 3250,
      },
    })).toEqual({
      inputTokens: 3000,
      cachedInputTokens: 300,
      outputTokens: 250,
      totalTokens: 3250,
      reported: true,
    });
  });

  it("normalizes OpenAI-compatible chat usage", () => {
    expect(normalizeAIProviderUsage({
      usage: {
        prompt_tokens: 800,
        prompt_tokens_details: { cached_tokens: 100 },
        completion_tokens: 120,
        total_tokens: 920,
      },
    })).toMatchObject({
      inputTokens: 800,
      cachedInputTokens: 100,
      outputTokens: 120,
      reported: true,
    });
  });

  it("normalizes Gemini usage metadata", () => {
    expect(normalizeAIProviderUsage({
      usageMetadata: {
        promptTokenCount: 500,
        cachedContentTokenCount: 50,
        candidatesTokenCount: 90,
        totalTokenCount: 590,
      },
    })).toEqual({
      inputTokens: 500,
      cachedInputTokens: 50,
      outputTokens: 90,
      totalTokens: 590,
      reported: true,
    });
  });

  it("marks missing provider usage as unreported", () => {
    expect(normalizeAIProviderUsage({})).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reported: false,
    });
  });
});

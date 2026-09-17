import { describe, expect, it } from "vitest";
import { normalizeAIModel } from "./ai";

describe("AI model compatibility", () => {
  it("keeps current provider model IDs unchanged", () => {
    expect(normalizeAIModel("openai", "gpt-5.6-terra", "gpt-5.6")).toBe("gpt-5.6-terra");
    expect(normalizeAIModel("gemini", "gemini-3.8-flash", "gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeAIModel("openrouter", "openai/gpt-5.6-sol", "openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
  });

  it("maps obsolete selector values to supported replacements", () => {
    expect(normalizeAIModel("openai", "gpt-5.6-mini", "gpt-5.6")).toBe("gpt-5.6-luna");
    expect(normalizeAIModel("gemini", "gemini-2.0-flash", "gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeAIModel("openrouter", "openai/gpt-5.6", "openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(normalizeAIModel("openrouter", "google/gemini-2.0-flash", "openai/gpt-5.6-sol")).toBe("google/gemini-3.8-flash");
  });

  it("uses the provider fallback when no model was saved", () => {
    expect(normalizeAIModel("openai", undefined, "gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });
});

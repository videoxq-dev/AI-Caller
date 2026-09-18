import { describe, expect, it } from "vitest";
import { quoteHostedUsage, type HostedRate } from "./pricing";

const now = new Date("2026-09-18T00:00:00Z");
const aiRates: HostedRate[] = [
  {
    id: "input",
    unit: "AI_INPUT_TOKEN",
    costMicros: 200_000,
    unitsPerCost: 1_000_000,
    targetMarginBps: 5500,
    provider: "openai",
    model: "gpt-5.6-luna",
    effectiveFrom: now,
  },
  {
    id: "cached",
    unit: "AI_CACHED_INPUT_TOKEN",
    costMicros: 20_000,
    unitsPerCost: 1_000_000,
    targetMarginBps: 5500,
    provider: "openai",
    model: "gpt-5.6-luna",
    effectiveFrom: now,
  },
  {
    id: "output",
    unit: "AI_OUTPUT_TOKEN",
    costMicros: 1_200_000,
    unitsPerCost: 1_000_000,
    targetMarginBps: 5500,
    provider: "openai",
    model: "gpt-5.6-luna",
    effectiveFrom: now,
  },
];

describe("hosted API pricing", () => {
  it("prices AI token usage at the configured target margin and rounds once to credits", () => {
    const quote = quoteHostedUsage(aiRates, [
      { unit: "AI_INPUT_TOKEN", units: 2700 },
      { unit: "AI_CACHED_INPUT_TOKEN", units: 300 },
      { unit: "AI_OUTPUT_TOKEN", units: 300 },
    ]);

    expect(quote.providerCostMicros).toBe(906);
    expect(quote.credits).toBe(3);
    expect(quote.billedUnits).toEqual({
      AI_INPUT_TOKEN: 2700,
      AI_CACHED_INPUT_TOKEN: 300,
      AI_OUTPUT_TOKEN: 300,
    });
  });

  it("prices a conservative US hosted SMS segment at 20 credits", () => {
    const quote = quoteHostedUsage([
      {
        id: "sms",
        unit: "SMS_SEGMENT",
        costMicros: 9000,
        unitsPerCost: 1,
        targetMarginBps: 5500,
        provider: "telnyx",
        model: "",
        effectiveFrom: now,
      },
    ], [{ unit: "SMS_SEGMENT", units: 1 }]);

    expect(quote.providerCostMicros).toBe(9000);
    expect(quote.credits).toBe(20);
  });

  it("does not charge for zero billable units", () => {
    expect(quoteHostedUsage(aiRates, [{ unit: "AI_INPUT_TOKEN", units: 0 }]).credits).toBe(0);
  });
});

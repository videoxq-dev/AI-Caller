import { describe, expect, it } from "vitest";
import { analyzeSmsSegments } from "./sms-segments";

describe("SMS segment metering", () => {
  it("uses GSM-7 single and concatenated segment limits", () => {
    expect(analyzeSmsSegments("a".repeat(160))).toEqual({ encoding: "GSM-7", units: 160, segments: 1 });
    expect(analyzeSmsSegments("a".repeat(161))).toEqual({ encoding: "GSM-7", units: 161, segments: 2 });
    expect(analyzeSmsSegments("a".repeat(306))).toEqual({ encoding: "GSM-7", units: 306, segments: 2 });
    expect(analyzeSmsSegments("a".repeat(307))).toEqual({ encoding: "GSM-7", units: 307, segments: 3 });
  });

  it("counts GSM extension characters as two septets", () => {
    expect(analyzeSmsSegments("^".repeat(80))).toEqual({ encoding: "GSM-7", units: 160, segments: 1 });
    expect(analyzeSmsSegments("^".repeat(81))).toEqual({ encoding: "GSM-7", units: 162, segments: 2 });
  });

  it("uses UCS-2 limits for Unicode outside GSM-7", () => {
    expect(analyzeSmsSegments("你".repeat(70))).toEqual({ encoding: "UCS-2", units: 70, segments: 1 });
    expect(analyzeSmsSegments("你".repeat(71))).toEqual({ encoding: "UCS-2", units: 71, segments: 2 });
    expect(analyzeSmsSegments("🙂".repeat(35))).toEqual({ encoding: "UCS-2", units: 70, segments: 1 });
    expect(analyzeSmsSegments("🙂".repeat(36))).toEqual({ encoding: "UCS-2", units: 72, segments: 2 });
  });
});

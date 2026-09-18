import { describe, expect, it } from "vitest";
import { evaluateQualification } from "./qualification";

describe("lead qualification evaluation", () => {
  const config = {
    enabled: true,
    criteria: [
      { id: "service", label: "Service", question: "What service do you need?", required: true },
      { id: "urgency", label: "Urgency", question: "How soon?", required: true },
      { id: "location", label: "Location", question: "Where?", required: false },
    ],
  };

  it("ignores unconfigured fields and qualifies only when required answers exist", () => {
    const partial = evaluateQualification(config, {}, [
      { criterionId: "service", answer: "HVAC repair" },
      { criterionId: "made_up", answer: "Should be ignored" },
    ]);
    expect(partial.qualified).toBe(false);
    expect(partial.answers).toEqual({ service: "HVAC repair" });
    expect(partial.missingRequired).toEqual([expect.objectContaining({ id: "urgency" })]);

    const complete = evaluateQualification(config, partial.answers, [
      { criterionId: "urgency", answer: "Today" },
    ]);
    expect(complete.qualified).toBe(true);
    expect(complete.answers).toEqual({ service: "HVAC repair", urgency: "Today" });
    expect(complete.score).toBe(67);
  });
});

import { describe, expect, it } from "vitest";
import { addBillingMonth } from "./billing-period";

describe("managed phone billing periods", () => {
  it("preserves the billing day when the next month contains it", () => {
    expect(addBillingMonth(new Date("2026-09-18T12:00:00.000Z")).toISOString()).toBe("2026-10-18T12:00:00.000Z");
  });

  it("clamps end-of-month billing dates", () => {
    expect(addBillingMonth(new Date("2026-01-31T12:00:00.000Z")).toISOString()).toBe("2026-02-28T12:00:00.000Z");
  });

  it("rolls December into the next year", () => {
    expect(addBillingMonth(new Date("2026-12-31T12:00:00.000Z")).toISOString()).toBe("2027-01-31T12:00:00.000Z");
  });
});

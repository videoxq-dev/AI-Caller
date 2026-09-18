import { describe, expect, it } from "vitest";
import { isWithinBusinessHours } from "./modes";

describe("voice business-hour routing", () => {
  it("treats equal open/close as an enabled 24-hour day", () => {
    expect(isWithinBusinessHours([
      { dayOfWeek: 1, enabled: true, openTime: "00:00", closeTime: "00:00" },
    ], 1, 12 * 60)).toBe(true);
  });

  it("carries an overnight schedule into the next disabled calendar day", () => {
    expect(isWithinBusinessHours([
      { dayOfWeek: 0, enabled: true, openTime: "22:00", closeTime: "02:00" },
      { dayOfWeek: 1, enabled: false, openTime: null, closeTime: null },
    ], 1, 60)).toBe(true);
    expect(isWithinBusinessHours([
      { dayOfWeek: 0, enabled: true, openTime: "22:00", closeTime: "02:00" },
      { dayOfWeek: 1, enabled: false, openTime: null, closeTime: null },
    ], 1, 3 * 60)).toBe(false);
  });

  it("uses a normal same-day open/close range", () => {
    const hours = [{ dayOfWeek: 2, enabled: true, openTime: "09:00", closeTime: "17:00" }];
    expect(isWithinBusinessHours(hours, 2, 9 * 60)).toBe(true);
    expect(isWithinBusinessHours(hours, 2, 17 * 60)).toBe(false);
  });
});

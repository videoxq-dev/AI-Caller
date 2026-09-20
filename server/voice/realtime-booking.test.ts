import { describe, expect, it } from "vitest";
import { realtimeBookingDetailsSchema, sameBookingInstant } from "./realtime-booking";

describe("Realtime booking memory and calendar instants", () => {
  it("accepts only explicit structured booking details", () => {
    expect(realtimeBookingDetailsSchema.parse({
      serviceName: "Office cleaning", date: "2026-09-26",
    })).toEqual({ serviceName: "Office cleaning", date: "2026-09-26" });
    expect(realtimeBookingDetailsSchema.safeParse({}).success).toBe(false);
    expect(realtimeBookingDetailsSchema.safeParse({ date: "September sometime" }).success)
      .toBe(false);
    expect(realtimeBookingDetailsSchema.safeParse({ time: "25:90" }).success)
      .toBe(false);
  });
  it("recognizes the same requested slot across UTC and local offsets", () => {
    expect(sameBookingInstant("2026-09-26T10:00:00-06:00",
      "2026-09-26T16:00:00.000Z")).toBe(true);
    expect(sameBookingInstant("2026-09-26T10:00:00-06:00",
      "2026-09-26T16:30:00.000Z")).toBe(false);
    expect(sameBookingInstant("not-a-date", "not-a-date")).toBe(false);
  });
});

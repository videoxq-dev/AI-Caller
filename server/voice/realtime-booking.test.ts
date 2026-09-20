import { describe, expect, it } from "vitest";
import { realtimeBookingDetailsSchema, sameBookingInstant, sameRealtimeBookingDetails } from "./realtime-booking";

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
  it("rejects superseded calendar results when service, time or location changed", () => {
    const details = { serviceName: "Office cleaning", location: "Sheridan",
      date: "2026-09-26", time: "10:00", timezone: "America/Denver" };
    expect(sameRealtimeBookingDetails(details, { ...details })).toBe(true);
    expect(sameRealtimeBookingDetails({ ...details, time: "11:00" }, details)).toBe(false);
    expect(sameRealtimeBookingDetails({ ...details, serviceName: "Industrial cleaning" }, details)).toBe(false);
    expect(sameRealtimeBookingDetails({ ...details, location: "Buffalo" }, details)).toBe(false);
    expect(sameRealtimeBookingDetails({ ...details, newField: "unexpected" }, details)).toBe(false);
  });

  it("recognizes the same requested slot across UTC and local offsets", () => {
    expect(sameBookingInstant("2026-09-26T10:00:00-06:00",
      "2026-09-26T16:00:00.000Z")).toBe(true);
    expect(sameBookingInstant("2026-09-26T10:00:00-06:00",
      "2026-09-26T16:30:00.000Z")).toBe(false);
    expect(sameBookingInstant("not-a-date", "not-a-date")).toBe(false);
  });
});

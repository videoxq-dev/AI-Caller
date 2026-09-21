import { describe, expect, it } from "vitest";
import { displayBookingInstant, parseBookingDate, parseBookingTime, resolveBookingLocalTime } from "./time";

const fixed = new Date("2026-09-21T12:00:00.000Z");

describe("server-owned booking date/time resolution", () => {
  it("accepts the exact screenshot's September 23 request as future", () => {
    const localDate = parseBookingDate("Sep 23, 2026", "Africa/Lagos", fixed);
    const localTime = parseBookingTime("11:00 AM (Africa/Lagos)");
    expect(localDate).toBe("2026-09-23");
    const slot = resolveBookingLocalTime({
      localDate, localTime: localTime.localTime, timezone: localTime.timezone!, durationMinutes: 240,
    }, fixed);
    expect(slot.startsAt.toISOString()).toBe("2026-09-23T10:00:00.000Z");
    expect(slot.endsAt.toISOString()).toBe("2026-09-23T14:00:00.000Z");
  });

  it("treats 10 AM UTC and 11 AM Lagos as the same instant, never an automatic mismatch", () => {
    const date = parseBookingDate("September 30, 2026", "Africa/Lagos", fixed);
    const lagos = resolveBookingLocalTime({ localDate: date, ...{
      localTime: parseBookingTime("11 am").localTime, timezone: "Africa/Lagos", durationMinutes: 240,
    } }, fixed);
    const utcTime = parseBookingTime("10 am UTC");
    const utc = resolveBookingLocalTime({
      localDate: date, localTime: utcTime.localTime, timezone: utcTime.timezone!, durationMinutes: 240,
    }, fixed);
    expect(utc.startsAt.getTime()).toBe(lagos.startsAt.getTime());
    expect(displayBookingInstant(utc.startsAt, "Africa/Lagos"))
      .toEqual({ localDate: date, localTime: "11:00", timezone: "Africa/Lagos" });
  });

  it("uses the supplied timezone rather than the machine's timezone", () => {
    const slot = resolveBookingLocalTime({
      localDate: "2026-09-23", localTime: "11:00", timezone: "Asia/Kathmandu", durationMinutes: 240,
    }, fixed);
    expect(slot.startsAt.toISOString()).toBe("2026-09-23T05:15:00.000Z");
    expect(slot.endsAt.toISOString()).toBe("2026-09-23T09:15:00.000Z");
  });

  it("does not silently reinterpret a DST gap or fold", () => {
    expect(() => resolveBookingLocalTime({
      localDate: "2027-03-14", localTime: "02:30",
      timezone: "America/New_York", durationMinutes: 60,
    }, fixed)).toThrowError(expect.objectContaining({ code: "BOOKING_LOCAL_TIME_NONEXISTENT" }));
    expect(() => resolveBookingLocalTime({
      localDate: "2027-11-07", localTime: "01:30",
      timezone: "America/New_York", durationMinutes: 60,
    }, fixed)).toThrowError(expect.objectContaining({ code: "BOOKING_LOCAL_TIME_AMBIGUOUS" }));
  });

  it("rejects invalid, ambiguous and contradictory dates and timezones", () => {
    for (const date of ["September 31, 2026", "2026-02-30"]) {
      expect(() => parseBookingDate(date, "UTC", fixed)).toThrowError(
        expect.objectContaining({ code: "BOOKING_DATE_INVALID" }),
      );
    }
    expect(() => parseBookingDate("09/10/26", "UTC", fixed)).toThrowError(
      expect.objectContaining({ code: "BOOKING_DATE_AMBIGUOUS" }),
    );
    expect(() => parseBookingDate("Tuesday, Sep 23, 2026", "UTC", fixed)).toThrowError(
      expect.objectContaining({ code: "BOOKING_WEEKDAY_MISMATCH" }),
    );
    expect(() => parseBookingTime("10 AM Mars/Olympus")).toThrow();
    expect(() => parseBookingTime("10 AM (Mars/Olympus)")).toThrowError(
      expect.objectContaining({ code: "BOOKING_TIMEZONE_INVALID" }),
    );
  });

  it("resolves relative dates against the supplied clock and zone", () => {
    expect(parseBookingDate("tomorrow", "Africa/Lagos", fixed)).toBe("2026-09-22");
    expect(parseBookingDate("Sep 20", "Africa/Lagos", fixed)).toBe("2027-09-20");
    expect(parseBookingDate("Sep 23", "Africa/Lagos", fixed)).toBe("2026-09-23");
    expect(parseBookingDate("Wednesday", "Africa/Lagos", fixed)).toBe("2026-09-23");
    expect(() => resolveBookingLocalTime({
      localDate: "2026-09-21", localTime: "10:00", timezone: "UTC", durationMinutes: 60,
    }, fixed)).toThrowError(expect.objectContaining({ code: "APPOINTMENT_IN_PAST" }));
  });
});

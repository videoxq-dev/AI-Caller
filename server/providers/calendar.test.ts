import { describe, expect, it } from "vitest";
import { slotize } from "./calendar";

describe("calendar availability slotting", () => {
  it("removes provider busy windows and keeps fixed booking slots", () => {
    const startsAt = new Date("2026-09-17T09:00:00.000Z");
    const endsAt = new Date("2026-09-17T12:00:00.000Z");
    const result = slotize(startsAt, endsAt, [
      { startsAt: new Date("2026-09-17T10:00:00.000Z"), endsAt: new Date("2026-09-17T10:30:00.000Z") },
    ], 30);

    expect(result.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-09-17T09:00:00.000Z",
      "2026-09-17T09:30:00.000Z",
      "2026-09-17T10:30:00.000Z",
      "2026-09-17T11:00:00.000Z",
      "2026-09-17T11:30:00.000Z",
    ]);
  });

  it("excludes slots that only partially overlap a busy window", () => {
    const result = slotize(
      new Date("2026-09-17T09:00:00.000Z"),
      new Date("2026-09-17T10:00:00.000Z"),
      [{ startsAt: new Date("2026-09-17T09:20:00.000Z"), endsAt: new Date("2026-09-17T09:40:00.000Z") }],
      30,
    );

    expect(result).toEqual([]);
  });
});

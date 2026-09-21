import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceContext: vi.fn(),
  getAvailability: vi.fn(),
}));

vi.mock("@/server/auth/workspace-context", () => ({
  resolveWorkspaceContext: mocks.resolveWorkspaceContext,
}));
vi.mock("@/server/domain/core/calendar-booking", () => ({
  calendarBookingService: { getAvailability: mocks.getAvailability },
}));

import { POST } from "./route";

describe("appointment availability route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceContext.mockResolvedValue({ workspace: { id: "workspace-1" } });
  });

  it("keeps slots as the top-level array while returning the authoritative timezone", async () => {
    mocks.getAvailability.mockResolvedValue({
      slots: [{
        startsAt: new Date("2030-09-23T10:00:00.000Z"),
        endsAt: new Date("2030-09-23T10:30:00.000Z"),
      }],
      timezone: "UTC",
    });
    const request = new Request("http://localhost/api/appointments/availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startsAt: "2030-09-23T08:00:00.000Z",
        endsAt: "2030-09-23T18:00:00.000Z",
        timezone: "UTC",
        durationMinutes: 30,
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      slots: [{
        startsAt: "2030-09-23T10:00:00.000Z",
        endsAt: "2030-09-23T10:30:00.000Z",
      }],
      timezone: "UTC",
    });
  });
});

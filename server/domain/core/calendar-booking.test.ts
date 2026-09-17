import { describe, expect, it, vi } from "vitest";
import type { CalendarProvider } from "@/server/providers/contracts";
import { createCalendarBookingService } from "./calendar-booking";

function provider(): CalendarProvider {
  return {
    getAvailability: vi.fn(async () => []),
    book: vi.fn(async (input) => ({ externalId: "event-1", startsAt: input.startsAt, endsAt: input.endsAt })),
    reschedule: vi.fn(async (input) => ({ externalId: input.externalId, startsAt: input.startsAt, endsAt: input.endsAt })),
    cancel: vi.fn(async () => undefined),
  };
}

const input = {
  contactId: "11111111-1111-4111-8111-111111111111",
  conversationId: null,
  serviceId: null,
  title: "Consultation",
  startsAt: new Date("2026-09-20T15:00:00.000Z"),
  endsAt: new Date("2026-09-20T15:30:00.000Z"),
  timezone: "America/New_York",
  bookingSource: "AI",
  notes: null,
  attendeeName: "Ada Lovelace",
  attendeeEmail: "ada@example.com",
};

describe("calendar booking service", () => {
  it("persists a normalized provider booking against the bound integration", async () => {
    const calendar = provider();
    const insertAppointment = vi.fn(async (_workspaceId, booking, external) => ({
      id: "appointment-1",
      ...booking,
      integrationId: external.integrationId,
      externalEventId: external.externalEventId,
      status: external.status,
    }));
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(async () => ({ integrationId: "integration-1", provider: calendar })),
      resolveForIntegration: vi.fn(async () => calendar),
      insertAppointment,
      getAppointment: vi.fn(),
      updateAfterReschedule: vi.fn(),
      setStatus: vi.fn(),
    });

    const result = await service.book("workspace-1", input);

    expect(calendar.book).toHaveBeenCalledOnce();
    expect(insertAppointment).toHaveBeenCalledWith("workspace-1", input, {
      integrationId: "integration-1",
      externalEventId: "event-1",
      status: "CONFIRMED",
    });
    expect(result.externalEventId).toBe("event-1");
  });

  it("uses the appointment's original integration when rescheduling", async () => {
    const calendar = provider();
    const resolveForIntegration = vi.fn(async () => calendar);
    const updateAfterReschedule = vi.fn(async (_workspaceId, _id, next) => ({ id: "appointment-1", ...next }));
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(),
      resolveForIntegration,
      insertAppointment: vi.fn(),
      getAppointment: vi.fn(async () => ({
        id: "appointment-1",
        integrationId: "integration-original",
        externalEventId: "event-1",
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        status: "CONFIRMED",
      })),
      updateAfterReschedule,
      setStatus: vi.fn(),
    });
    const next = {
      startsAt: new Date("2026-09-21T16:00:00.000Z"),
      endsAt: new Date("2026-09-21T16:30:00.000Z"),
      timezone: "America/New_York",
    };

    await service.reschedule("workspace-1", "appointment-1", next);

    expect(resolveForIntegration).toHaveBeenCalledWith("workspace-1", "integration-original");
    expect(calendar.reschedule).toHaveBeenCalledWith({ externalId: "event-1", ...next });
  });

  it("rolls back the provider event if local booking persistence fails", async () => {
    const calendar = provider();
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(async () => ({ integrationId: "integration-1", provider: calendar })),
      resolveForIntegration: vi.fn(async () => calendar),
      insertAppointment: vi.fn(async () => { throw new Error("database unavailable"); }),
      getAppointment: vi.fn(),
      updateAfterReschedule: vi.fn(),
      setStatus: vi.fn(),
    });

    await expect(service.book("workspace-1", input)).rejects.toThrow("database unavailable");
    expect(calendar.cancel).toHaveBeenCalledWith({ externalId: "event-1" });
  });
});

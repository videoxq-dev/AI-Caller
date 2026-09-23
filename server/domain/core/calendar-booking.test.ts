import { describe, expect, it, vi } from "vitest";
import type { CalendarProvider } from "@/server/providers/contracts";
import { createCalendarBookingService } from "./calendar-booking";
import type { AppointmentInput } from "./schemas";

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

function storedAppointment(overrides: Partial<{
  id: string;
  integrationId: string | null;
  externalEventId: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
}> = {}) {
  return {
    id: "appointment-1",
    integrationId: "integration-1",
    externalEventId: "event-1",
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    timezone: input.timezone,
    status: "CONFIRMED" as const,
    ...overrides,
  };
}

describe("calendar booking service", () => {
  it("uses native availability when no usable external calendar route exists", async () => {
    const nativeAvailability = vi.fn(async () => ({
      timezone: "America/New_York",
      slots: [{
        startsAt: new Date("2026-09-21T14:00:00.000Z"),
        endsAt: new Date("2026-09-21T14:30:00.000Z"),
      }],
    }));
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(async () => null),
      nativeAvailability,
      resolveForIntegration: vi.fn(),
      insertAppointment: vi.fn(),
      getAppointment: vi.fn(),
      updateAfterReschedule: vi.fn(),
      setStatus: vi.fn(),
    });

    const result = await service.getAvailability("workspace-1", {
      startsAt: new Date("2026-09-21T13:00:00.000Z"),
      endsAt: new Date("2026-09-21T17:00:00.000Z"),
      timezone: "America/New_York",
      durationMinutes: 30,
    });

    expect(nativeAvailability).toHaveBeenCalledOnce();
    expect(result.slots).toHaveLength(1);
    expect(result.timezone).toBe("America/New_York");
  });

  it("uses native booking when no usable external calendar route exists", async () => {
    const validateNativeBooking = vi.fn(async () => ({
      timezone: "America/New_York",
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxBookingsPerDay: 8,
    }));
    const insertNativeAppointment = vi.fn(async (_workspaceId: string, booking: AppointmentInput) => ({
      id: "appointment-native",
      workspaceId: "workspace-1",
      contactId: booking.contactId,
      conversationId: booking.conversationId ?? null,
      integrationId: null,
      externalEventId: null,
      serviceId: booking.serviceId ?? null,
      title: booking.title,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      timezone: booking.timezone,
      status: "CONFIRMED" as const,
      bookingSource: booking.bookingSource ?? null,
      notes: booking.notes ?? null,
      bookingCommandId: null,
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
      updatedAt: new Date("2026-09-20T12:00:00.000Z"),
    }));
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(async () => null),
      validateNativeBooking,
      insertNativeAppointment,
      resolveForIntegration: vi.fn(),
      insertAppointment: vi.fn(),
      getAppointment: vi.fn(),
      updateAfterReschedule: vi.fn(),
      setStatus: vi.fn(),
    });

    const result = await service.book("workspace-1", input);

    expect(validateNativeBooking).toHaveBeenCalledWith("workspace-1", input);
    expect(insertNativeAppointment).toHaveBeenCalledOnce();
    expect(result.integrationId).toBeNull();
    expect(result.externalEventId).toBeNull();
  });

  it("persists a normalized provider booking against the bound integration", async () => {
    const calendar = provider();
    const insertAppointment = vi.fn(async (_workspaceId, booking, external) => storedAppointment({
      integrationId: external.integrationId,
      externalEventId: external.externalEventId,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      timezone: booking.timezone,
      status: external.status ?? "CONFIRMED",
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
    const updateAfterReschedule = vi.fn(async (_workspaceId, _id, next) => storedAppointment({
      startsAt: next.startsAt,
      endsAt: next.endsAt,
      timezone: next.timezone,
    }));
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(),
      resolveForIntegration,
      insertAppointment: vi.fn(),
      getAppointment: vi.fn(async () => storedAppointment({ integrationId: "integration-original" })),
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

  it("does not mutate a provider appointment after its approval snapshot becomes stale", async () => {
    const calendar = provider();
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(),
      resolveForIntegration: vi.fn(async () => calendar),
      insertAppointment: vi.fn(),
      getAppointment: vi.fn(async () => ({
        ...storedAppointment(),
        updatedAt: new Date("2037-09-23T12:00:00.000Z"),
      })),
      updateAfterReschedule: vi.fn(),
      setStatus: vi.fn(),
    });
    const proposal = {
      startsAt: new Date("2037-09-24T10:00:00.000Z"),
      endsAt: new Date("2037-09-24T10:30:00.000Z"),
      timezone: "America/New_York",
    };
    await expect(service.reschedule(
      "workspace-1", "appointment-1", proposal,
      new Date("2037-09-22T12:00:00.000Z"),
    )).rejects.toMatchObject({ code: "APPOINTMENT_CHANGED" });
    expect(calendar.reschedule).not.toHaveBeenCalled();
    await expect(service.cancel(
      "workspace-1", "appointment-1",
      new Date("2037-09-22T12:00:00.000Z"),
    )).rejects.toMatchObject({ code: "APPOINTMENT_CHANGED" });
    expect(calendar.cancel).not.toHaveBeenCalled();
  });

  it("does not silently change a connected provider event's local service only", async () => {
    const calendar = provider();
    const service = createCalendarBookingService({
      resolveCurrent: vi.fn(),
      resolveForIntegration: vi.fn(async () => calendar),
      insertAppointment: vi.fn(),
      getAppointment: vi.fn(async () => storedAppointment()),
      updateAfterReschedule: vi.fn(),
      setStatus: vi.fn(),
    });
    await expect(service.reschedule("workspace-1", "appointment-1", {
      startsAt: new Date("2037-09-24T10:00:00.000Z"),
      endsAt: new Date("2037-09-24T10:30:00.000Z"),
      timezone: "America/New_York",
    }, undefined, { serviceId: "different-service", title: "Industrial Cleaning" }))
      .rejects.toMatchObject({ code: "APPOINTMENT_SERVICE_CHANGE_UNSUPPORTED" });
    expect(calendar.reschedule).not.toHaveBeenCalled();
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

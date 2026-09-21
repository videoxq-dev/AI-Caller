import type { CalendarProvider } from "@/server/providers/contracts";
import { resolveCalendarProvider, resolveCalendarProviderForIntegration } from "@/server/providers/registry";
import { resolveProviderRoute } from "@/server/providers/resolver";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { assertAppointmentReferences } from "./references";
import {
  getAppointment,
  insertAppointment,
  insertNativeAppointment,
  setAppointmentStatus,
  updateAppointmentAfterReschedule,
  updateNativeAppointmentAfterReschedule,
} from "./repository";
import type { AppointmentInput, AppointmentRescheduleInput } from "./schemas";
import { nativeAvailability, validateNativeBooking } from "./native-calendar";

type StoredAppointment = {
  id: string;
  integrationId: string | null;
  externalEventId: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
};

type BookingDependencies = {
  resolveCurrent: (workspaceId: string) => Promise<{ integrationId: string; provider: CalendarProvider } | null>;
  nativeAvailability?: typeof nativeAvailability;
  validateNativeBooking?: typeof validateNativeBooking;
  insertNativeAppointment?: typeof insertNativeAppointment;
  updateNativeAppointmentAfterReschedule?: typeof updateNativeAppointmentAfterReschedule;
  resolveForIntegration: (workspaceId: string, integrationId: string) => Promise<CalendarProvider>;
  validateBooking?: (workspaceId: string, input: AppointmentInput) => Promise<void>;
  insertAppointment: (
    workspaceId: string,
    input: AppointmentInput,
    external: { integrationId: string | null; externalEventId: string | null; status?: "PENDING" | "CONFIRMED" },
  ) => Promise<StoredAppointment>;
  getAppointment: (workspaceId: string, appointmentId: string) => Promise<StoredAppointment | null>;
  updateAfterReschedule: (
    workspaceId: string,
    appointmentId: string,
    input: AppointmentRescheduleInput,
    externalEventId?: string,
  ) => Promise<StoredAppointment>;
  setStatus: (
    workspaceId: string,
    appointmentId: string,
    status: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW",
  ) => Promise<StoredAppointment>;
};

async function defaultResolveCurrent(workspaceId: string) {
  const route = await resolveProviderRoute(workspaceId, "CALENDAR");
  if (!route || route.mode !== "BYOP" || !route.integrationId) {
    return null;
  }
  return {
    integrationId: route.integrationId,
    provider: await resolveCalendarProvider(workspaceId),
  };
}

const defaultDependencies: BookingDependencies = {
  resolveCurrent: defaultResolveCurrent,
  nativeAvailability,
  validateNativeBooking,
  insertNativeAppointment,
  updateNativeAppointmentAfterReschedule,
  resolveForIntegration: resolveCalendarProviderForIntegration,
  validateBooking: assertAppointmentReferences,
  insertAppointment,
  getAppointment,
  updateAfterReschedule: updateAppointmentAfterReschedule,
  setStatus: setAppointmentStatus,
};

export function createCalendarBookingService(dependencies: BookingDependencies) {
  return {
    async getAvailability(
      workspaceId: string,
      input: Parameters<CalendarProvider["getAvailability"]>[0],
    ) {
      const current = await dependencies.resolveCurrent(workspaceId);
      if (!current) {
        if (!dependencies.nativeAvailability) throw new AppError("NATIVE_BOOKING_UNAVAILABLE", "In-app scheduling is temporarily unavailable.", 503);
        return dependencies.nativeAvailability(workspaceId, input);
      }
      return current.provider.getAvailability(input);
    },

    async book(workspaceId: string, input: AppointmentInput) {
      await dependencies.validateBooking?.(workspaceId, input);
      const current = await dependencies.resolveCurrent(workspaceId);
      if (!current) {
        if (!dependencies.validateNativeBooking || !dependencies.insertNativeAppointment) {
          throw new AppError("NATIVE_BOOKING_UNAVAILABLE", "In-app scheduling is temporarily unavailable.", 503);
        }
        const validated = await dependencies.validateNativeBooking(workspaceId, input);
        return dependencies.insertNativeAppointment(workspaceId, {
          ...input,
          timezone: validated.timezone,
        });
      }
      const { integrationId, provider } = current;
      const providerBooking = await provider.book({
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        title: input.title,
        attendeeName: input.attendeeName ?? undefined,
        attendeeEmail: input.attendeeEmail ?? undefined,
      });

      try {
        return await dependencies.insertAppointment(
          workspaceId,
          { ...input, startsAt: providerBooking.startsAt, endsAt: providerBooking.endsAt },
          {
            integrationId,
            externalEventId: providerBooking.externalId,
            status: "CONFIRMED",
          },
        );
      } catch (error) {
        try {
          await provider.cancel({ externalId: providerBooking.externalId });
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError, workspaceId, integrationId, externalEventId: providerBooking.externalId },
            "Failed to roll back calendar event after local appointment persistence failure",
          );
        }
        throw error;
      }
    },

    async reschedule(workspaceId: string, appointmentId: string, input: AppointmentRescheduleInput) {
      const appointment = await dependencies.getAppointment(workspaceId, appointmentId);
      if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
      if (appointment.status === "CANCELLED") {
        throw new AppError("APPOINTMENT_CANCELLED", "Cancelled appointments cannot be rescheduled.", 409);
      }
      if (!appointment.integrationId && !appointment.externalEventId) {
        if (!dependencies.validateNativeBooking || !dependencies.updateNativeAppointmentAfterReschedule) {
          throw new AppError("NATIVE_BOOKING_UNAVAILABLE", "In-app scheduling is temporarily unavailable.", 503);
        }
        const validated = await dependencies.validateNativeBooking(workspaceId, input);
        return dependencies.updateNativeAppointmentAfterReschedule(workspaceId, appointmentId, {
          ...input,
          timezone: validated.timezone,
        });
      }
      if (!appointment.integrationId || !appointment.externalEventId) {
        throw new AppError("APPOINTMENT_NOT_SYNCED", "This appointment has an incomplete external calendar link.", 409);
      }

      const provider = await dependencies.resolveForIntegration(workspaceId, appointment.integrationId);
      const providerBooking = await provider.reschedule({
        externalId: appointment.externalEventId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
      });

      try {
        return await dependencies.updateAfterReschedule(
          workspaceId,
          appointmentId,
          { ...input, startsAt: providerBooking.startsAt, endsAt: providerBooking.endsAt },
          providerBooking.externalId,
        );
      } catch (error) {
        try {
          await provider.reschedule({
            externalId: providerBooking.externalId,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            timezone: appointment.timezone,
          });
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError, workspaceId, appointmentId, externalEventId: providerBooking.externalId },
            "Failed to roll back provider reschedule after local appointment update failure",
          );
        }
        throw error;
      }
    },

    async cancel(workspaceId: string, appointmentId: string) {
      const appointment = await dependencies.getAppointment(workspaceId, appointmentId);
      if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
      if (appointment.status === "CANCELLED") return appointment;

      if (appointment.integrationId && appointment.externalEventId) {
        const provider = await dependencies.resolveForIntegration(workspaceId, appointment.integrationId);
        await provider.cancel({ externalId: appointment.externalEventId });
      }

      return dependencies.setStatus(workspaceId, appointmentId, "CANCELLED");
    },
  };
}

export const calendarBookingService = createCalendarBookingService(defaultDependencies);

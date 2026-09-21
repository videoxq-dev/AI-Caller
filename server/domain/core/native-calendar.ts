import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { getBusinessSetup } from "@/server/domain/onboarding/repository";
import { getCalendarSetup } from "@/server/domain/integrations/repository";
import { calendarSetupSchema } from "@/server/domain/integrations/schemas";
import { AppError } from "@/server/http/errors";

type Window = { startsAt: Date; endsAt: Date };
type Hours = { dayOfWeek: number; enabled: boolean; openTime: string | null; closeTime: string | null };
type AvailabilityInput = Window & { timezone: string; durationMinutes?: number };
type NativeSchedule = {
  timezone: string;
  hours: Hours[];
  defaultDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  maxBookingsPerDay: number;
};

export type NativeBookingPolicy = Pick<NativeSchedule,
  "timezone" | "bufferBeforeMinutes" | "bufferAfterMinutes" | "maxBookingsPerDay">;

const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(date);
  const part = (name: string) => parts.find(row => row.type === name)?.value ?? "";
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday")),
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")) };
}
function timeMinute(value: string | null) {
  if (!value || !/^\d\d:\d\d$/.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export function withinBusinessHours(window: Window, timezone: string, hours: Hours[]) {
  const begin = localParts(window.startsAt, timezone);
  const end = localParts(new Date(window.endsAt.getTime() - 1), timezone);
  const row = hours.find(item => item.dayOfWeek === begin.day);
  const opening = timeMinute(row?.openTime ?? null);
  const closing = timeMinute(row?.closeTime ?? null);
  return window.endsAt > window.startsAt && begin.date === end.date
    && Boolean(row?.enabled) && opening !== null && closing !== null
    && begin.minute >= opening && end.minute < closing;
}

export async function nativeHours(workspaceId: string) {
  const [business, rawCalendar] = await Promise.all([
    getBusinessSetup(workspaceId),
    getCalendarSetup(workspaceId),
  ]);
  const parsedCalendar = rawCalendar
    ? calendarSetupSchema.safeParse({ ...rawCalendar, completeStep: false })
    : null;
  if (parsedCalendar && !parsedCalendar.success) {
    throw new AppError("CALENDAR_CONFIG_INVALID",
      "The saved calendar availability settings are invalid. Please save them again.", 409);
  }
  const calendar = parsedCalendar?.data ?? null;
  if (!business.profile || !business.hours.some(row => row.enabled)) {
    throw new AppError("BUSINESS_HOURS_NOT_CONFIGURED",
      "Set your business hours before checking or booking in-app appointments.", 409);
  }
  if (!calendar) {
    return {
      timezone: business.profile.timezone,
      hours: business.hours,
      defaultDurationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxBookingsPerDay: Number.MAX_SAFE_INTEGER,
    } satisfies NativeSchedule;
  }

  const available = new Set(calendar.availableDays);
  const calendarStart = timeMinute(calendar.startTime);
  const calendarEnd = timeMinute(calendar.endTime);
  const hours = business.hours.map((row) => {
    const businessStart = timeMinute(row.openTime);
    const businessEnd = timeMinute(row.closeTime);
    const enabled = row.enabled && available.has(weekDays[row.dayOfWeek])
      && businessStart !== null && businessEnd !== null
      && calendarStart !== null && calendarEnd !== null;
    const start = enabled ? Math.max(businessStart, calendarStart) : 0;
    const end = enabled ? Math.min(businessEnd, calendarEnd) : 0;
    const value = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    return {
      ...row,
      enabled: enabled && start < end,
      openTime: enabled && start < end ? value(start) : null,
      closeTime: enabled && start < end ? value(end) : null,
    };
  });
  if (!hours.some((row) => row.enabled)) {
    throw new AppError("BUSINESS_HOURS_NOT_CONFIGURED",
      "Calendar availability does not overlap the configured business hours.", 409);
  }
  return {
    timezone: calendar.timezone,
    hours,
    defaultDurationMinutes: calendar.meetingDurationMinutes,
    bufferBeforeMinutes: calendar.bufferBeforeMinutes,
    bufferAfterMinutes: calendar.bufferAfterMinutes,
    maxBookingsPerDay: calendar.maxBookingsPerDay,
  } satisfies NativeSchedule;
}

function conflictsWithBuffer(window: Window, existing: Window[], beforeMinutes: number, afterMinutes: number) {
  const protectedStart = window.startsAt.getTime() - beforeMinutes * 60_000;
  const protectedEnd = window.endsAt.getTime() + afterMinutes * 60_000;
  return existing.some((row) => row.startsAt.getTime() < protectedEnd
    && row.endsAt.getTime() > protectedStart);
}

export async function nativeAvailability(workspaceId: string, input: AvailabilityInput) {
  const schedule = await nativeHours(workspaceId);
  const { timezone, hours } = schedule;
  const durationMinutes = input.durationMinutes ?? schedule.defaultDurationMinutes;
  const duration = durationMinutes * 60_000;
  const start = input.startsAt.getTime(), end = input.endsAt.getTime();
  if (end <= start || end - start > 7 * 24 * 60 * 60_000 || durationMinutes < 5 || durationMinutes > 1440) {
    throw new AppError("AVAILABILITY_RANGE_INVALID", "Check a date range of at most seven days and a valid appointment duration.", 422);
  }
  const existing = await db.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments).where(and(
      eq(appointments.workspaceId, workspaceId),
      inArray(appointments.status, ["PENDING", "CONFIRMED"]),
      // Include the whole surrounding civil day so daily limits and buffers
      // immediately outside the requested window are still authoritative.
      lt(appointments.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
      gt(appointments.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
    )).limit(1000);
  const slots: Window[] = [];
  // Scan on the smallest civil-time offset used by IANA zones, then accept
  // local :00/:30 boundaries. UTC-only 30-minute stepping would never produce
  // a local half-hour in zones such as Asia/Kathmandu (UTC+05:45).
  const scanStep = 15 * 60_000;
  const first = Math.ceil(Math.max(start, Date.now()) / scanStep) * scanStep;
  for (let at = first; at + duration <= end && slots.length < 12; at += scanStep) {
    const slot = { startsAt: new Date(at), endsAt: new Date(at + duration) };
    const localStart = localParts(slot.startsAt, timezone);
    const dayBookings = existing.filter((row) => localParts(row.startsAt, timezone).date === localStart.date).length;
    if (localStart.minute % 30 === 0 && withinBusinessHours(slot, timezone, hours)
      && dayBookings < schedule.maxBookingsPerDay
      && !conflictsWithBuffer(slot, existing,
        schedule.bufferBeforeMinutes, schedule.bufferAfterMinutes)) slots.push(slot);
  }
  return { slots, timezone };
}

export async function validateNativeBooking(
  workspaceId: string,
  window: Window,
  excludeAppointmentId?: string,
) {
  const schedule = await nativeHours(workspaceId);
  const { timezone, hours } = schedule;
  if (window.startsAt.getTime() < Date.now()) {
    throw new AppError("APPOINTMENT_IN_PAST", "Please choose a future appointment time.", 422);
  }
  if (!withinBusinessHours(window, timezone, hours)) {
    throw new AppError("APPOINTMENT_OUTSIDE_HOURS", "That appointment is outside the configured business hours.", 409);
  }
  const candidateDay = localParts(window.startsAt, timezone).date;
  const queryStart = new Date(window.startsAt.getTime() - 36 * 60 * 60_000);
  const queryEnd = new Date(window.endsAt.getTime() + 36 * 60 * 60_000);
  const conditions = [
    eq(appointments.workspaceId, workspaceId),
    inArray(appointments.status, ["PENDING", "CONFIRMED"]),
    lt(appointments.startsAt, queryEnd),
    gt(appointments.endsAt, queryStart),
  ];
  if (excludeAppointmentId) conditions.push(ne(appointments.id, excludeAppointmentId));
  const existing = await db.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments).where(and(...conditions)).limit(1000);
  if (existing.filter((row) => localParts(row.startsAt, timezone).date === candidateDay).length
    >= schedule.maxBookingsPerDay) {
    throw new AppError("APPOINTMENT_DAILY_LIMIT_REACHED",
      "The maximum number of bookings has been reached for that day.", 409);
  }
  if (conflictsWithBuffer(window, existing,
    schedule.bufferBeforeMinutes, schedule.bufferAfterMinutes)) {
    throw new AppError("APPOINTMENT_SLOT_UNAVAILABLE",
      "That time conflicts with another appointment or its required buffer.", 409);
  }
  return {
    timezone,
    bufferBeforeMinutes: schedule.bufferBeforeMinutes,
    bufferAfterMinutes: schedule.bufferAfterMinutes,
    maxBookingsPerDay: schedule.maxBookingsPerDay,
  } satisfies NativeBookingPolicy;
}

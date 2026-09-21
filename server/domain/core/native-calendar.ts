import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { appointments, bookingReservations } from "@/db/schema";
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
  businessTimezone: string;
  businessHours: Hours[];
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

function withinNativeSchedule(window: Window, schedule: NativeSchedule) {
  return withinBusinessHours(window, schedule.timezone, schedule.hours)
    && withinBusinessHours(window, schedule.businessTimezone, schedule.businessHours);
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
      businessTimezone: business.profile.timezone,
      businessHours: business.hours,
      defaultDurationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxBookingsPerDay: Number.MAX_SAFE_INTEGER,
    } satisfies NativeSchedule;
  }

  const available = new Set(calendar.availableDays);
  const calendarStart = timeMinute(calendar.startTime);
  const calendarEnd = timeMinute(calendar.endTime);
  const validCalendarWindow = calendarStart !== null && calendarEnd !== null
    && calendarStart < calendarEnd;
  const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    enabled: validCalendarWindow && available.has(weekDays[dayOfWeek]),
    openTime: validCalendarWindow ? calendar.startTime : null,
    closeTime: validCalendarWindow ? calendar.endTime : null,
  }));
  if (!hours.some((row) => row.enabled)) {
    throw new AppError("BUSINESS_HOURS_NOT_CONFIGURED",
      "Calendar availability does not include a valid booking window.", 409);
  }
  return {
    timezone: calendar.timezone,
    hours,
    businessTimezone: business.profile.timezone,
    businessHours: business.hours,
    defaultDurationMinutes: calendar.meetingDurationMinutes,
    bufferBeforeMinutes: calendar.bufferBeforeMinutes,
    bufferAfterMinutes: calendar.bufferAfterMinutes,
    maxBookingsPerDay: calendar.maxBookingsPerDay,
  } satisfies NativeSchedule;
}

function conflictsWithBuffer(window: Window, existing: Window[], beforeMinutes: number, afterMinutes: number) {
  const protectedStart = window.startsAt.getTime() - beforeMinutes * 60_000;
  const protectedEnd = window.endsAt.getTime() + afterMinutes * 60_000;
  return existing.some((row) => {
    const existingProtectedStart = row.startsAt.getTime() - beforeMinutes * 60_000;
    const existingProtectedEnd = row.endsAt.getTime() + afterMinutes * 60_000;
    return existingProtectedStart < protectedEnd && existingProtectedEnd > protectedStart;
  });
}

// External calendars must obey the same local business, buffer, daily-limit and
// existing-appointment rules as native scheduling. Provider success alone is
// not authority to ignore an already-booked local appointment.
export async function filterSlotsThroughLocalPolicy(
  workspaceId: string,
  input: AvailabilityInput,
  offered: Window[],
  now = new Date(),
  excludeCommandId?: string,
) {
  const schedule = await nativeHours(workspaceId);
  if (!Number.isFinite(input.startsAt.getTime()) || !Number.isFinite(input.endsAt.getTime()) ||
    input.endsAt <= input.startsAt ||
    input.endsAt.getTime() - input.startsAt.getTime() > 7 * 24 * 60 * 60_000 ||
    offered.length > 10_000) {
    throw new AppError("AVAILABILITY_RANGE_INVALID", "Cannot safely check this calendar range.", 422);
  }
  const [existingBookings, reservations] = await Promise.all([
    db.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments).where(and(
      eq(appointments.workspaceId, workspaceId),
      inArray(appointments.status, ["PENDING", "CONFIRMED"]),
      lt(appointments.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
      gt(appointments.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
    )).limit(1001),
    db.select({ startsAt: bookingReservations.startsAt, endsAt: bookingReservations.endsAt })
      .from(bookingReservations).where(and(
        eq(bookingReservations.workspaceId, workspaceId),
        eq(bookingReservations.state, "ACTIVE"),
        ...(excludeCommandId ? [ne(bookingReservations.commandId, excludeCommandId)] : []),
        lt(bookingReservations.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
        gt(bookingReservations.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
      )).limit(1001),
  ]);
  const existing = [...existingBookings, ...reservations];
  if (existingBookings.length > 1000 || reservations.length > 1000) {
    throw new AppError("AVAILABILITY_INCOMPLETE", "There are too many appointments to check availability safely.", 503);
  }
  const duration = input.durationMinutes;
  const slots = offered.filter((slot) => {
    if (!Number.isFinite(slot.startsAt.getTime()) || !Number.isFinite(slot.endsAt.getTime()) ||
      slot.startsAt < input.startsAt || slot.endsAt > input.endsAt || slot.startsAt <= now ||
      slot.endsAt <= slot.startsAt ||
      (duration !== undefined && slot.endsAt.getTime() - slot.startsAt.getTime() !== duration * 60_000)) {
      return false;
    }
    const day = localParts(slot.startsAt, schedule.timezone).date;
    const dailyCount = existing.filter((row) =>
      localParts(row.startsAt, schedule.timezone).date === day).length;
    return dailyCount < schedule.maxBookingsPerDay &&
      withinNativeSchedule(slot, schedule) &&
      !conflictsWithBuffer(slot, existing, schedule.bufferBeforeMinutes, schedule.bufferAfterMinutes);
  });
  return { slots, timezone: input.timezone };
}

export async function nativeAvailability(workspaceId: string, input: AvailabilityInput) {
  const schedule = await nativeHours(workspaceId);
  const { timezone } = schedule;
  const durationMinutes = input.durationMinutes ?? schedule.defaultDurationMinutes;
  const duration = durationMinutes * 60_000;
  const start = input.startsAt.getTime(), end = input.endsAt.getTime();
  if (end <= start || end - start > 7 * 24 * 60 * 60_000 || durationMinutes < 5 || durationMinutes > 1440) {
    throw new AppError("AVAILABILITY_RANGE_INVALID", "Check a date range of at most seven days and a valid appointment duration.", 422);
  }
  const [existingBookings, reservations] = await Promise.all([
    db.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments).where(and(
      eq(appointments.workspaceId, workspaceId),
      inArray(appointments.status, ["PENDING", "CONFIRMED"]),
      // Include the whole surrounding civil day so daily limits and buffers
      // immediately outside the requested window are still authoritative.
      lt(appointments.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
      gt(appointments.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
    )).limit(1001),
    db.select({ startsAt: bookingReservations.startsAt, endsAt: bookingReservations.endsAt })
      .from(bookingReservations).where(and(
        eq(bookingReservations.workspaceId, workspaceId),
        eq(bookingReservations.state, "ACTIVE"),
        lt(bookingReservations.startsAt, new Date(input.endsAt.getTime() + 36 * 60 * 60_000)),
        gt(bookingReservations.endsAt, new Date(input.startsAt.getTime() - 36 * 60 * 60_000)),
      )).limit(1001),
  ]);
  const existing = [...existingBookings, ...reservations];
  if (existingBookings.length > 1000 || reservations.length > 1000) {
    throw new AppError("AVAILABILITY_INCOMPLETE", "There are too many appointments to check availability safely.", 503);
  }
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
    if (localStart.minute % 30 === 0 && withinNativeSchedule(slot, schedule)
      && dayBookings < schedule.maxBookingsPerDay
      && !conflictsWithBuffer(slot, existing,
        schedule.bufferBeforeMinutes, schedule.bufferAfterMinutes)) slots.push(slot);
  }
  return { slots, timezone };
}

export async function validateNativeBooking(
  workspaceId: string,
  window: Window,
) {
  const schedule = await nativeHours(workspaceId);
  const { timezone } = schedule;
  if (window.startsAt.getTime() < Date.now()) {
    throw new AppError("APPOINTMENT_IN_PAST", "Please choose a future appointment time.", 422);
  }
  if (!withinNativeSchedule(window, schedule)) {
    throw new AppError("APPOINTMENT_OUTSIDE_HOURS", "That appointment is outside the configured business hours.", 409);
  }
  // Availability, buffer, daily-limit and idempotency checks run together
  // under the repository's workspace transaction lock. Repeating them here
  // creates a race where one identical retry commits before the other reaches
  // the lock and the second can no longer be recognized as idempotent.
  return {
    timezone,
    bufferBeforeMinutes: schedule.bufferBeforeMinutes,
    bufferAfterMinutes: schedule.bufferAfterMinutes,
    maxBookingsPerDay: schedule.maxBookingsPerDay,
  } satisfies NativeBookingPolicy;
}

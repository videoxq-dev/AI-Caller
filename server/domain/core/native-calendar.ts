import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { getBusinessSetup } from "@/server/domain/onboarding/repository";
import { AppError } from "@/server/http/errors";

type Window = { startsAt: Date; endsAt: Date };
type Hours = { dayOfWeek: number; enabled: boolean; openTime: string | null; closeTime: string | null };
type AvailabilityInput = Window & { timezone: string; durationMinutes?: number };

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
  const setup = await getBusinessSetup(workspaceId);
  if (!setup.profile || !setup.hours.some(row => row.enabled)) {
    throw new AppError("BUSINESS_HOURS_NOT_CONFIGURED",
      "Set your business hours before checking or booking in-app appointments.", 409);
  }
  return { timezone: setup.profile.timezone, hours: setup.hours };
}

export async function nativeAvailability(workspaceId: string, input: AvailabilityInput) {
  const { timezone, hours } = await nativeHours(workspaceId);
  const durationMinutes = input.durationMinutes ?? 30;
  const duration = durationMinutes * 60_000;
  const start = input.startsAt.getTime(), end = input.endsAt.getTime();
  if (end <= start || end - start > 7 * 24 * 60 * 60_000 || durationMinutes < 5 || durationMinutes > 480) {
    throw new AppError("AVAILABILITY_RANGE_INVALID", "Check a date range of at most seven days and a valid appointment duration.", 422);
  }
  const existing = await db.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments).where(and(
      eq(appointments.workspaceId, workspaceId),
      inArray(appointments.status, ["PENDING", "CONFIRMED"]),
      lt(appointments.startsAt, input.endsAt), gt(appointments.endsAt, input.startsAt),
    )).limit(1000);
  const slots: Window[] = [];
  const first = Math.ceil(Math.max(start, Date.now()) / (30 * 60_000)) * 30 * 60_000;
  for (let at = first; at + duration <= end && slots.length < 12; at += 30 * 60_000) {
    const slot = { startsAt: new Date(at), endsAt: new Date(at + duration) };
    if (withinBusinessHours(slot, timezone, hours)
      && !existing.some(row => row.startsAt < slot.endsAt && row.endsAt > slot.startsAt)) slots.push(slot);
  }
  return slots;
}

export async function validateNativeBooking(workspaceId: string, window: Window) {
  const { timezone, hours } = await nativeHours(workspaceId);
  if (window.startsAt.getTime() < Date.now()) {
    throw new AppError("APPOINTMENT_IN_PAST", "Please choose a future appointment time.", 422);
  }
  if (!withinBusinessHours(window, timezone, hours)) {
    throw new AppError("APPOINTMENT_OUTSIDE_HOURS", "That appointment is outside the configured business hours.", 409);
  }
}

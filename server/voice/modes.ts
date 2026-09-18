import { getBusinessSetup } from "@/server/domain/onboarding/repository";
import { getVoiceConfig } from "./config";

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localDayAndMinute(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = DAY_INDEX[values.weekday ?? ""];
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (!Number.isInteger(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error("Unable to determine local business time.");
  }
  return { day, minuteOfDay: hour * 60 + minute };
}

function parseMinute(value: string | null) {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

export function isWithinBusinessHours(
  hours: Awaited<ReturnType<typeof getBusinessSetup>>["hours"],
  day: number,
  minuteOfDay: number,
) {
  const today = hours.find((row) => row.dayOfWeek === day);
  if (today?.enabled) {
    const open = parseMinute(today.openTime);
    const close = parseMinute(today.closeTime);
    if (open != null && close != null) {
      if (open === close) return true;
      if (open < close && minuteOfDay >= open && minuteOfDay < close) return true;
      if (open > close && minuteOfDay >= open) return true;
    }
  }

  const previousDay = (day + 6) % 7;
  const previous = hours.find((row) => row.dayOfWeek === previousDay);
  if (!previous?.enabled) return false;
  const previousOpen = parseMinute(previous.openTime);
  const previousClose = parseMinute(previous.closeTime);
  return previousOpen != null
    && previousClose != null
    && previousOpen > previousClose
    && minuteOfDay < previousClose;
}

export async function resolveInboundVoiceMode(workspaceId: string, now = new Date()) {
  const [business, voice] = await Promise.all([
    getBusinessSetup(workspaceId),
    getVoiceConfig(workspaceId),
  ]);
  if (!voice.config.afterHoursEnabled || !business.profile || business.hours.length === 0) {
    return "AI_FIRST" as const;
  }
  const local = localDayAndMinute(now, business.profile.timezone);
  return isWithinBusinessHours(business.hours, local.day, local.minuteOfDay)
    ? "AI_FIRST" as const
    : "AFTER_HOURS" as const;
}

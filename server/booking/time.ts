import { AppError } from "@/server/http/errors";

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };
export type ResolvedBookingTime = {
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  localTime: string;
  timezone: string;
};
const months: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
  october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function bookingError(code: string, message: string): never {
  throw new AppError(code, message, 422);
}

function zoneFormatter(timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return bookingError("BOOKING_TIMEZONE_INVALID", "Please provide a valid timezone.");
  }
}

function zoneParts(formatter: Intl.DateTimeFormat, instant: Date): LocalParts {
  const parts = formatter.formatToParts(instant);
  const number = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number("year"), month: number("month"), day: number("day"),
    hour: number("hour"), minute: number("minute"),
  };
}

function validDate(year: number, month: number, day: number) {
  const instant = new Date(Date.UTC(year, month - 1, day));
  return year >= 1970 && year <= 9999 && instant.getUTCFullYear() === year
    && instant.getUTCMonth() + 1 === month && instant.getUTCDate() === day;
}

function formatDate(year: number, month: number, day: number) {
  return [String(year).padStart(4, "0"), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

function fromIsoDate(input: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (!validDate(year, month, day)) bookingError("BOOKING_DATE_INVALID", "That date does not exist.");
  return { year, month, day };
}

function weekdayOf(year: number, month: number, day: number) {
  return weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function parseBookingDate(
  expression: string,
  timezone: string,
  now = new Date(),
): string {
  const formatter = zoneFormatter(timezone);
  if (!Number.isFinite(now.getTime())) bookingError("BOOKING_CLOCK_INVALID", "Unable to determine the current date.");
  const value = expression.trim().toLowerCase().replace(/\s+/g, " ");
  const today = zoneParts(formatter, now);
  const iso = fromIsoDate(value);
  if (iso) return formatDate(iso.year, iso.month, iso.day);
  if (/^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(value)) {
    bookingError("BOOKING_DATE_AMBIGUOUS", "Please write the date using a month name, such as September 23, 2026.");
  }
  const weekdayPrefix = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+/.exec(value);
  const normalized = weekdayPrefix ? value.slice(weekdayPrefix[0].length) : value;
  const relative = /^(today|tomorrow|next (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))$/.exec(normalized);
  if (relative) {
    const calendarToday = new Date(Date.UTC(today.year, today.month - 1, today.day));
    let days = relative[1] === "tomorrow" ? 1 : 0;
    if (weekdays.includes(relative[1]) || relative[1].startsWith("next ")) {
      const weekday = relative[1].replace("next ", "");
      const desired = weekdays.indexOf(weekday);
      days = (desired - calendarToday.getUTCDay() + 7) % 7;
      if (days === 0 || relative[1].startsWith("next ")) days = days === 0 ? 7 : days;
    }
    calendarToday.setUTCDate(calendarToday.getUTCDate() + days);
    return formatDate(calendarToday.getUTCFullYear(), calendarToday.getUTCMonth() + 1, calendarToday.getUTCDate());
  }
  const named = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(normalized);
  if (!named) bookingError("BOOKING_DATE_UNRECOGNIZED", "Please specify a date, for example September 23, 2026.");
  const month = months[named[1]], day = Number(named[2]);
  let year = named[3] ? Number(named[3]) : today.year;
  if (!validDate(year, month, day)) bookingError("BOOKING_DATE_INVALID", "That date does not exist.");
  if (!named[3] && (
    month < today.month || (month === today.month && day < today.day)
  )) year += 1;
  if (!validDate(year, month, day)) bookingError("BOOKING_DATE_INVALID", "That date does not exist.");
  if (weekdayPrefix && weekdayOf(year, month, day) !== weekdayPrefix[1]) {
    bookingError("BOOKING_WEEKDAY_MISMATCH", "The weekday and date do not match. Which date would you prefer?");
  }
  return formatDate(year, month, day);
}

export function parseBookingTime(expression: string): { localTime: string; timezone: string | null } {
  const value = expression.trim();
  const explicitZone = /(?:\s*\(([^()]+)\)|\s+(UTC|GMT))$/i.exec(value);
  const timezone = explicitZone ? (explicitZone[1] ?? explicitZone[2]).trim() : null;
  if (timezone) zoneFormatter(timezone);
  const time = explicitZone ? value.slice(0, -explicitZone[0].length).trim() : value;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(time);
  if (!match) bookingError("BOOKING_TIME_UNRECOGNIZED", "Please give a time, for example 11 AM.");
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (match[3]) {
    if (hour < 1 || hour > 12) bookingError("BOOKING_TIME_INVALID", "Please give a valid time.");
    hour = hour % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) bookingError("BOOKING_TIME_INVALID", "Please give a valid time.");
  return { localTime: String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0"), timezone };
}

export function resolveBookingLocalTime(input: {
  localDate: string;
  localTime: string;
  timezone: string;
  durationMinutes: number;
}, now = new Date()): ResolvedBookingTime {
  const date = fromIsoDate(input.localDate);
  if (!date) bookingError("BOOKING_DATE_INVALID", "Please provide an ISO calendar date.");
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.localTime);
  if (!time) bookingError("BOOKING_TIME_INVALID", "Please provide a valid local time.");
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 1440) {
    bookingError("BOOKING_DURATION_INVALID", "The service needs a valid configured duration.");
  }
  const formatter = zoneFormatter(input.timezone);
  const hour = Number(time[1]), minute = Number(time[2]);
  const localUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsets = new Set<number>();
  // Derive actual zone offsets around the target civil day; never ask Date.parse
  // to guess a locale string or silently accept a DST gap/fold.
  for (let sample = localUtc - 36 * 3_600_000; sample <= localUtc + 36 * 3_600_000; sample += 30 * 60_000) {
    const parts = zoneParts(formatter, new Date(sample));
    offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - sample);
  }
  const candidates = [...offsets].map((offset) => new Date(localUtc - offset)).filter((instant) => {
    const parts = zoneParts(formatter, instant);
    return parts.year === date.year && parts.month === date.month && parts.day === date.day
      && parts.hour === hour && parts.minute === minute;
  });
  const unique = [...new Set(candidates.map((instant) => instant.getTime()))];
  if (!unique.length) bookingError("BOOKING_LOCAL_TIME_NONEXISTENT", "That local time does not exist because of a timezone change. Choose another time.");
  if (unique.length > 1) bookingError("BOOKING_LOCAL_TIME_AMBIGUOUS", "That local time occurs twice because of a timezone change. Please specify a UTC offset or a different time.");
  const startsAt = new Date(unique[0]);
  if (startsAt.getTime() <= now.getTime()) bookingError("APPOINTMENT_IN_PAST", "Please choose a future appointment date and time.");
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + input.durationMinutes * 60_000),
    localDate: input.localDate,
    localTime: input.localTime,
    timezone: input.timezone,
  };
}

export function displayBookingInstant(instant: Date, timezone: string) {
  const parts = zoneParts(zoneFormatter(timezone), instant);
  return { localDate: formatDate(parts.year, parts.month, parts.day),
    localTime: String(parts.hour).padStart(2, "0") + ":" + String(parts.minute).padStart(2, "0"),
    timezone };
}

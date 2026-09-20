import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { voiceRealtimeBookingState } from "@/db/schema";
import { AppError } from "@/server/http/errors";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().min(1).max(100).refine(tz => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }).format(); return true; }
  catch { return false; }
});
export const realtimeBookingDetailsSchema = z.object({
  serviceName: z.string().trim().min(1).max(160).optional(),
  location: z.string().trim().min(1).max(250).optional(),
  date: localDate.optional(),
  time: localTime.optional(),
  timezone: timezone.optional(),
}).strict().refine(value => Object.keys(value).length > 0);

export async function captureRealtimeBookingDetails(
  workspaceId: string, callId: string, input: unknown) {
  const detail = realtimeBookingDetailsSchema.parse(input);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${callId}))`);
    const [existing] = await tx.select().from(voiceRealtimeBookingState).where(and(
      eq(voiceRealtimeBookingState.workspaceId, workspaceId),
      eq(voiceRealtimeBookingState.voiceCallId, callId),
    )).limit(1);
    const merged = { ...(existing?.details ?? {}), ...detail };
    // Any changed booking field requires a NEW availability verification.
    const changed = Object.entries(detail).some(([key, value]) => existing?.details[key] !== value);
    const [row] = await tx.insert(voiceRealtimeBookingState).values({
      workspaceId, voiceCallId: callId, details: merged,
      availableStart: changed ? null : existing?.availableStart ?? null,
    }).onConflictDoUpdate({ target: voiceRealtimeBookingState.voiceCallId,
      set: { details: merged,
        availableStart: changed ? null : existing?.availableStart ?? null,
        updatedAt: new Date() },
    }).returning();
    return { details: row.details, availabilityMustBeRechecked: !row.availableStart };
  });
}

export async function saveRealtimeAvailability(workspaceId: string, callId: string,
  startsAt: string, available: boolean) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${callId}))`);
    const [existing] = await tx.select().from(voiceRealtimeBookingState).where(and(
      eq(voiceRealtimeBookingState.workspaceId, workspaceId),
      eq(voiceRealtimeBookingState.voiceCallId, callId),
    )).limit(1);
    if (!existing) return;
    await tx.update(voiceRealtimeBookingState).set({
      availableStart: available ? startsAt : null, updatedAt: new Date(),
    }).where(and(eq(voiceRealtimeBookingState.workspaceId, workspaceId),
      eq(voiceRealtimeBookingState.voiceCallId, callId)));
  });
}

function dateTimeParts(startsAt: string, tz: string) {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) throw new AppError("BOOKING_DATE_INVALID", "Appointment start is invalid.", 422);
  const pieces = new Intl.DateTimeFormat("en-US", { timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const fields = Object.fromEntries(pieces.map(p => [p.type, p.value]));
  return { date: `${fields.year}-${fields.month}-${fields.day}`,
    time: `${fields.hour}:${fields.minute}` };
}

/** Block booking until service/date/time/location are actually collected and checked. */
export async function assertRealtimeBookingReady(
  workspaceId: string, callId: string,
  proposed: { title: string; startsAt: string; timezone: string },
) {
  const [row] = await db.select().from(voiceRealtimeBookingState).where(and(
    eq(voiceRealtimeBookingState.workspaceId, workspaceId),
    eq(voiceRealtimeBookingState.voiceCallId, callId),
  )).limit(1);
  const details = row?.details ?? {};
  if (!details.serviceName || !details.location || !details.date || !details.time
    || !details.timezone || !row?.availableStart) {
    throw new AppError("BOOKING_DETAILS_REQUIRED",
      "Confirm the service, location, date and time, then check availability before booking.", 409);
  }
  const start = dateTimeParts(proposed.startsAt, proposed.timezone);
  if (start.date !== details.date || start.time !== details.time
    || proposed.timezone !== details.timezone
    || !proposed.title.toLowerCase().includes(details.serviceName.toLowerCase())
    || row.availableStart !== proposed.startsAt) {
    throw new AppError("BOOKING_DETAILS_CHANGED",
      "The appointment differs from the caller's latest request; collect and recheck the requested slot.", 409);
  }
}

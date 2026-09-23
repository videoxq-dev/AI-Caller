import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appointmentManagementRequests, appointments, bookingDrafts, bookingReservations, messages, services,
} from "@/db/schema";
import { capabilitiesFromBehaviorSettings, type AgentCapability } from "@/server/agent/capabilities";
import { getWorkspaceAgent } from "@/server/agent/service";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { escalateConversationIssue } from "@/server/collaboration/service";
import { assertNativePolicyAvailability } from "@/server/domain/core/repository";
import { validateNativeBooking } from "@/server/domain/core/native-calendar";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { isExplicitActionConfirmation } from "@/server/orchestrator/pending-actions";
import { resolveCalendarProviderForIntegration } from "@/server/providers/registry";
import {
  displayBookingInstant, parseBookingDate, parseBookingTime, resolveBookingLocalTime,
} from "./time";
import type { BookingContext } from "./drafts";

type RequestRow = typeof appointmentManagementRequests.$inferSelect;
type Appointment = typeof appointments.$inferSelect;
type Intent = "RESCHEDULE" | "CANCEL" | "STATUS";

export type AppointmentManagementTurn = {
  reply: string;
  preview?: { requestId: string; version: number };
};

const ACTIVE = ["COLLECTING", "AWAITING_CONFIRMATION", "EXECUTING"];
const EDITABLE_APPOINTMENT = ["PENDING", "CONFIRMED"] as const;
const REQUEST_TTL_MS = 30 * 60_000;
const DATE_PATTERN = /\b(?:\d{4}-\d{2}-\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|today|tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const TIME_PATTERN = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*\([^()]{1,80}\)|\s+UTC)?|\d{1,2}:\d{2}(?:\s*\([^()]{1,80}\)|\s+UTC)?)(?=\s|$|[,!?])/i;

export function appointmentManagementIntent(text: string): Intent | null {
  const hasAppointment = /\b(?:appointment|booking|reservation)\b/i.test(text);
  if (!hasAppointment) return null;
  if (/\b(?:cancel|cancellation)\b/i.test(text)) return "CANCEL";
  if (/\b(?:reschedul\w*|move|change|update|modify|edit)\b/i.test(text)) return "RESCHEDULE";
  if (/\b(?:status|confirmed|when|what time|upcoming|scheduled|details)\b/i.test(text)) return "STATUS";
  return null;
}

function owned(ctx: BookingContext) {
  return and(
    eq(appointmentManagementRequests.workspaceId, ctx.workspaceId),
    eq(appointmentManagementRequests.contactId, ctx.contactId),
    eq(appointmentManagementRequests.conversationId, ctx.conversationId!),
    eq(appointmentManagementRequests.channel, ctx.channel),
    eq(appointmentManagementRequests.sessionKey, ctx.sessionKey),
  );
}

function humanTime(value: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, dateStyle: "medium", timeStyle: "short",
  }).format(value) + " (" + timezone + ")";
}

function appointmentLabel(value: Appointment) {
  return value.title + " on " + humanTime(value.startsAt, value.timezone);
}

async function linkedAppointments(ctx: BookingContext, now: Date, includePast = false) {
  return db.select().from(appointments).where(and(
    eq(appointments.workspaceId, ctx.workspaceId),
    eq(appointments.contactId, ctx.contactId),
    includePast ? undefined : inArray(appointments.status, EDITABLE_APPOINTMENT),
    includePast ? undefined : gt(appointments.startsAt, now),
  )).orderBy(includePast ? desc(appointments.updatedAt) : asc(appointments.startsAt)).limit(6);
}

async function findOwnedAppointment(ctx: BookingContext, id: string) {
  const [row] = await db.select().from(appointments).where(and(
    eq(appointments.workspaceId, ctx.workspaceId),
    eq(appointments.contactId, ctx.contactId),
    eq(appointments.id, id),
  )).limit(1);
  return row ?? null;
}

function selectAppointment(rows: Appointment[], text: string) {
  if (rows.length === 1) return rows[0];
  const ordinal = /\b(first|second|third|fourth|fifth|[1-5])\b/i.exec(text)?.[1].toLowerCase();
  const numbers: Record<string, number> = {
    first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
    "1": 0, "2": 1, "3": 2, "4": 3, "5": 4,
  };
  if (ordinal) return rows[numbers[ordinal]] ?? null;
  const match = rows.filter(row => text.toLowerCase().includes(row.title.toLowerCase()));
  return match.length === 1 ? match[0] : null;
}

function chooseReply(rows: Appointment[]) {
  if (!rows.length) return "I can't find an upcoming appointment linked to this conversation's contact. If it was booked under another contact or chat session, please ask the business team to verify it. I won't change a different customer's appointment.";
  if (rows.length > 5) return "I found several appointments linked to this contact. Please contact the business team to identify which one to change safely.";
  return "Which existing appointment do you mean? " +
    rows.map((row, index) => (index + 1) + ". " + appointmentLabel(row)).join("; ") +
    ". Reply with its number or service name.";
}

function extractRequestedTime(text: string) {
  const date = DATE_PATTERN.exec(text)?.[0] ?? null;
  const time = TIME_PATTERN.exec(text)?.[1] ?? null;
  return { date, time };
}

async function currentRequest(ctx: BookingContext, now: Date) {
  const [row] = await db.select().from(appointmentManagementRequests)
    .where(and(owned(ctx), inArray(appointmentManagementRequests.status, ACTIVE)))
    .orderBy(desc(appointmentManagementRequests.createdAt)).limit(1);
  if (!row) return null;
  if (row.expiresAt <= now && row.status !== "EXECUTING") {
    await db.update(appointmentManagementRequests)
      .set({ status: "ABANDONED", updatedAt: now })
      .where(and(eq(appointmentManagementRequests.id, row.id),
        inArray(appointmentManagementRequests.status, ["COLLECTING", "AWAITING_CONFIRMATION"])));
    return null;
  }
  return row;
}

async function unresolvedChange(ctx: BookingContext, appointment: Appointment) {
  const [pending] = await db.select().from(appointmentManagementRequests)
    .where(and(
      eq(appointmentManagementRequests.workspaceId, ctx.workspaceId),
      eq(appointmentManagementRequests.contactId, ctx.contactId),
      eq(appointmentManagementRequests.appointmentId, appointment.id),
      inArray(appointmentManagementRequests.status, ["EXECUTING", "RECONCILING"]),
    )).orderBy(desc(appointmentManagementRequests.createdAt)).limit(1);
  if (!pending) return null;
  const matchesSavedOutcome = pending.intent === "CANCEL"
    ? appointment.status === "CANCELLED"
    : Boolean(pending.proposedStartsAt && pending.proposedEndsAt
        && appointment.startsAt.getTime() === pending.proposedStartsAt.getTime()
        && appointment.endsAt.getTime() === pending.proposedEndsAt.getTime()
        && (!pending.proposedServiceId || appointment.serviceId === pending.proposedServiceId));
  if (matchesSavedOutcome) {
    await db.update(appointmentManagementRequests).set({
      status: "COMPLETED", completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(appointmentManagementRequests.id, pending.id),
      inArray(appointmentManagementRequests.status, ["EXECUTING", "RECONCILING"])));
    return "The saved appointment shows " + appointmentLabel(appointment) +
      " — " + appointment.status.toLowerCase() + ". No additional change was made.";
  }
  return "A previous change to " + appointmentLabel(appointment) +
    " has an unresolved calendar outcome. I won't submit a duplicate change. " +
    "Please ask the business team to verify the calendar and resolve this appointment issue.";
}

async function hasUnfinishedBooking(ctx: BookingContext, now: Date) {
  const [draft] = await db.select({ id: bookingDrafts.id })
    .from(bookingDrafts).where(and(
      eq(bookingDrafts.workspaceId, ctx.workspaceId),
      eq(bookingDrafts.contactId, ctx.contactId),
      eq(bookingDrafts.channel, ctx.channel),
      eq(bookingDrafts.sessionKey, ctx.sessionKey),
      or(
        inArray(bookingDrafts.status, ["COMMITTING", "RECONCILING"]),
        and(
          inArray(bookingDrafts.status, ["COLLECTING", "AVAILABILITY_CHECKED", "AWAITING_CONFIRMATION"]),
          gt(bookingDrafts.expiresAt, now),
        ),
      ),
    )).limit(1);
  return Boolean(draft);
}

async function openRequest(ctx: BookingContext, intent: "RESCHEDULE" | "CANCEL", now: Date) {
  const [inserted] = await db.insert(appointmentManagementRequests).values({
    workspaceId: ctx.workspaceId, contactId: ctx.contactId,
    conversationId: ctx.conversationId!, channel: ctx.channel,
    sessionKey: ctx.sessionKey, intent, expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
  }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const current = await currentRequest(ctx, now);
  if (current) return current;
  throw new AppError("APPOINTMENT_MANAGEMENT_CONFLICT",
    "The appointment change could not be started safely. Please try again.", 409);
}

async function saveRequest(row: RequestRow, patch: Partial<RequestRow>, now: Date) {
  const [updated] = await db.update(appointmentManagementRequests)
    .set({ ...patch, version: sql`${appointmentManagementRequests.version} + 1`, updatedAt: now })
    .where(and(eq(appointmentManagementRequests.id, row.id),
      eq(appointmentManagementRequests.version, row.version),
      eq(appointmentManagementRequests.status, row.status))).returning();
  if (!updated) throw new AppError("APPOINTMENT_MANAGEMENT_CHANGED",
    "The appointment request changed. Please ask for its current status.", 409);
  return updated;
}

async function agentAllows(ctx: BookingContext, capability: AgentCapability) {
  const agent = await getWorkspaceAgent(ctx.workspaceId);
  if (!agent || agent.status !== "ACTIVE") return false;
  return capabilitiesFromBehaviorSettings(agent.behaviorSettings)[capability];
}

async function availableForReschedule(ctx: BookingContext, appointment: Appointment, startsAt: Date, endsAt: Date, now: Date) {
  if (startsAt <= now) throw new AppError("APPOINTMENT_IN_PAST", "Please choose a future appointment time.", 422);
  const window = { startsAt, endsAt, timezone: appointment.timezone };
  const policy = await validateNativeBooking(ctx.workspaceId, window);
  const [others, reservations] = await Promise.all([
    db.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
      .from(appointments).where(and(
        eq(appointments.workspaceId, ctx.workspaceId),
        ne(appointments.id, appointment.id),
        inArray(appointments.status, EDITABLE_APPOINTMENT),
        lt(appointments.startsAt, new Date(endsAt.getTime() + 36 * 60 * 60_000)),
        gt(appointments.endsAt, new Date(startsAt.getTime() - 36 * 60 * 60_000)),
      )).limit(1001),
    db.select({ startsAt: bookingReservations.startsAt, endsAt: bookingReservations.endsAt })
      .from(bookingReservations).where(and(
        eq(bookingReservations.workspaceId, ctx.workspaceId),
        eq(bookingReservations.state, "ACTIVE"),
        lt(bookingReservations.startsAt, new Date(endsAt.getTime() + 36 * 60 * 60_000)),
        gt(bookingReservations.endsAt, new Date(startsAt.getTime() - 36 * 60 * 60_000)),
      )).limit(1001),
  ]);
  if (others.length > 1000 || reservations.length > 1000) {
    throw new AppError("AVAILABILITY_INCOMPLETE", "I can't verify all calendar conflicts safely right now.", 503);
  }
  assertNativePolicyAvailability(window, [...others, ...reservations], policy);
  if (appointment.integrationId) {
    if (!appointment.externalEventId) {
      throw new AppError("APPOINTMENT_NOT_SYNCED", "This appointment needs staff review before rescheduling.", 409);
    }
    const provider = await resolveCalendarProviderForIntegration(ctx.workspaceId, appointment.integrationId);
    const slots = await provider.getAvailability({
      startsAt, endsAt, timezone: appointment.timezone,
      durationMinutes: (endsAt.getTime() - startsAt.getTime()) / 60_000,
    });
    if (!slots.some(slot => slot.startsAt.getTime() === startsAt.getTime()
      && slot.endsAt.getTime() === endsAt.getTime())) {
      throw new AppError("APPOINTMENT_SLOT_UNAVAILABLE",
        "That exact time isn't available. Which other date or time would you prefer?", 409);
    }
  }
}

function errorMessage(error: unknown) {
  if (error instanceof AppError && error.status < 500) return error.message;
  logger.error({ err: error }, "Appointment management could not confirm its outcome");
  return "I couldn't verify the appointment change. Please ask the business team to check it before trying again.";
}

async function statusReply(ctx: BookingContext, rows: Appointment[]) {
  if (!rows.length) return "I can't find an appointment linked to this conversation's contact. Please ask the business team to verify a booking made through a different contact or session.";
  if (rows.length > 5) return "There are several linked appointments; please ask the business team which one you mean.";
  const details = await Promise.all(rows.map(async row => {
    const unresolved = await unresolvedChange(ctx, row);
    return unresolved ?? appointmentLabel(row) + " — " + row.status.toLowerCase();
  }));
  return details.join("; ") + ".";
}

async function finishRequest(ctx: BookingContext, row: RequestRow, sourceMessageId: string, now: Date) {
  if (!row.appointmentId) return { reply: "Which appointment do you mean?" };
  const appointment = await findOwnedAppointment(ctx, row.appointmentId);
  if (!appointment) return { reply: "I can't verify an appointment linked to this contact. No change was made." };
  if (row.status === "EXECUTING") {
    if (row.intent === "CANCEL" && appointment.status === "CANCELLED") {
      await saveRequest(row, { status: "COMPLETED", completedAt: now }, now);
      return { reply: "Your " + appointmentLabel(appointment) + " appointment is cancelled." };
    }
    if (row.intent === "RESCHEDULE" && row.proposedStartsAt && row.proposedEndsAt &&
      appointment.startsAt.getTime() === row.proposedStartsAt.getTime() &&
      appointment.endsAt.getTime() === row.proposedEndsAt.getTime() &&
      (!row.proposedServiceId || appointment.serviceId === row.proposedServiceId)) {
      await saveRequest(row, { status: "COMPLETED", completedAt: now }, now);
      return { reply: "Your appointment is confirmed for " + appointmentLabel(appointment) + "." };
    }
    return { reply: "I'm still verifying whether the requested appointment change completed. I won't execute it a second time. Please ask the business team to check the saved appointment." };
  }
  if (row.status !== "AWAITING_CONFIRMATION" || !row.previewDeliveredAt) {
    return { reply: "I haven't delivered a confirmed appointment-change preview yet. Please ask for the details again." };
  }
  const [source] = await db.select({
    createdAt: messages.createdAt, body: messages.body,
  }).from(messages).where(and(eq(messages.workspaceId, ctx.workspaceId),
    eq(messages.conversationId, ctx.conversationId!), eq(messages.id, sourceMessageId),
    eq(messages.channel, ctx.channel),
    eq(messages.senderType, "CUSTOMER"),
    inArray(messages.contentType, ["TEXT", "CALL_TRANSCRIPT"]),
    ctx.channel === "PHONE"
      ? sql`${messages.metadata}->>'voiceCallId' = ${ctx.sessionKey}`
      : undefined,
  )).limit(1);
  if (!source || !isExplicitActionConfirmation(source.body)
    || source.createdAt <= row.previewDeliveredAt) {
    return { reply: "Please confirm only after I've shown the appointment change. No change was made." };
  }
  if (!await agentAllows(ctx, row.intent === "CANCEL" ? "CANCEL_APPOINTMENT" : "RESCHEDULE_APPOINTMENT")) {
    return { reply: "I'm not permitted to make that appointment change. No change was made." };
  }
  const unchanged = appointment.status === "CANCELLED" ||
    appointment.updatedAt.getTime() !== row.originalUpdatedAt?.getTime() ||
    appointment.startsAt.getTime() !== row.originalStartsAt?.getTime() ||
    appointment.endsAt.getTime() !== row.originalEndsAt?.getTime();
  if (unchanged) {
    await saveRequest(row, { status: "ABANDONED" }, now);
    return { reply: "That appointment has changed since I prepared the proposal. I haven't made another change. Please ask me to check its current details." };
  }

  // Claim BEFORE calling any external calendar provider. A crash/timeout is
  // deliberately non-retryable until the saved appointment outcome is verified.
  const [claimed] = await db.update(appointmentManagementRequests).set({
    status: "EXECUTING", sourceEventId: sourceMessageId, updatedAt: now,
  }).where(and(eq(appointmentManagementRequests.id, row.id),
    eq(appointmentManagementRequests.version, row.version),
    eq(appointmentManagementRequests.status, "AWAITING_CONFIRMATION"),
    eq(appointmentManagementRequests.previewDeliveredAt, row.previewDeliveredAt))).returning();
  if (!claimed) return { reply: "This appointment change is already being processed. Please ask for its status before trying again." };
  try {
    // Serialize consequential changes to the SAME appointment across every
    // conversation/session. The version check must happen AFTER acquiring
    // the lock and BEFORE the external provider call.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtext(${`appointment-management:${ctx.workspaceId}:${appointment.id}`})
      )`);
      const [latest] = await tx.select().from(appointments).where(and(
        eq(appointments.workspaceId, ctx.workspaceId),
        eq(appointments.contactId, ctx.contactId),
        eq(appointments.id, appointment.id),
      )).limit(1);
      if (!latest || !row.originalUpdatedAt ||
        !EDITABLE_APPOINTMENT.includes(latest.status as typeof EDITABLE_APPOINTMENT[number]) ||
        latest.updatedAt.getTime() !== row.originalUpdatedAt.getTime() ||
        latest.startsAt.getTime() !== row.originalStartsAt?.getTime() ||
        latest.endsAt.getTime() !== row.originalEndsAt?.getTime()) {
        throw new AppError("APPOINTMENT_SNAPSHOT_STALE",
          "The appointment changed before I could submit the approved request.", 409);
      }
      if (row.intent === "CANCEL") {
        await calendarBookingService.cancel(
          ctx.workspaceId, appointment.id, row.originalUpdatedAt,
        );
      } else {
        if (!row.proposedStartsAt || !row.proposedEndsAt) {
          throw new AppError("APPOINTMENT_CHANGE_INCOMPLETE", "Please choose a new date and time.", 422);
        }
        const serviceChange = row.proposedServiceId
          ? await tx.select().from(services).where(and(
              eq(services.workspaceId, ctx.workspaceId),
              eq(services.id, row.proposedServiceId),
              eq(services.active, true),
            )).limit(1).then(rows => rows[0] ?? null)
          : null;
        if (row.proposedServiceId && !serviceChange) {
          throw new AppError("APPOINTMENT_SERVICE_UNAVAILABLE",
            "The requested service is no longer available.", 409);
        }
        await availableForReschedule(ctx, latest, row.proposedStartsAt, row.proposedEndsAt, now);
        await calendarBookingService.reschedule(ctx.workspaceId, appointment.id, {
          startsAt: row.proposedStartsAt, endsAt: row.proposedEndsAt,
          timezone: row.timezone ?? latest.timezone,
        }, row.originalUpdatedAt,
        serviceChange ? { serviceId: serviceChange.id, title: serviceChange.name } : undefined);
      }
    });
    const updated = await findOwnedAppointment(ctx, appointment.id);
    if (!updated) throw new AppError("APPOINTMENT_NOT_FOUND",
      "The saved appointment could not be verified after its change.", 503);
    await db.update(appointmentManagementRequests).set({
      status: "COMPLETED", completedAt: new Date(), updatedAt: new Date(),
    }).where(eq(appointmentManagementRequests.id, row.id));
    return { reply: row.intent === "CANCEL"
      ? "Your " + appointmentLabel(updated) + " appointment is cancelled."
      : "Your existing appointment has been rescheduled and confirmed for " + appointmentLabel(updated) + ". No new appointment was created." };
  } catch (error) {
    // The provider might have accepted a request whose response timed out.
    // Never re-send an uncertain cancellation/reschedule automatically.
    // A timeout or failed persistence after a provider call is not proof the
    // provider rejected the change. Keep a cross-session appointment hold
    // until an authoritative saved outcome can be observed or staff resolve it.
    const knownRejection = error instanceof AppError && error.status < 500
      && error.code !== "APPOINTMENT_CHANGED";
    await db.update(appointmentManagementRequests).set({
      status: knownRejection ? "FAILED" : "RECONCILING",
      completedAt: knownRejection ? new Date() : null, updatedAt: new Date(),
    }).where(eq(appointmentManagementRequests.id, row.id));
    let reply = errorMessage(error) +
      " I haven't confirmed that your appointment was changed; please ask the business team to verify it.";
    if (!knownRejection && ctx.conversationId) {
      try {
        const agent = await getWorkspaceAgent(ctx.workspaceId);
        if (agent && /escalate/i.test(agent.whenUnsure)
          && capabilitiesFromBehaviorSettings(agent.behaviorSettings).ESCALATE) {
          await escalateConversationIssue({
            workspaceId: ctx.workspaceId, conversationId: ctx.conversationId,
            reason: "Existing appointment " + appointment.id +
              " has an uncertain calendar mutation (" + row.intent +
              "); staff must reconcile its provider and saved appointment state.",
          });
          reply += " I've flagged this specific appointment issue for staff follow-up.";
        }
      } catch (escalationError) {
        logger.error({ err: escalationError, workspaceId: ctx.workspaceId,
          appointmentId: appointment.id }, "Uncertain appointment outcome could not be escalated");
      }
    }
    return { reply };
  }
}

export async function recordAppointmentManagementPreviewDelivery(
  ctx: BookingContext, requestId: string, deliveryReference: string,
  expectedVersion: number,
) {
  await db.update(appointmentManagementRequests).set({
    previewDeliveredAt: new Date(),
    previewDeliveryReference: deliveryReference,
  }).where(and(owned(ctx), eq(appointmentManagementRequests.id, requestId),
    eq(appointmentManagementRequests.version, expectedVersion),
    eq(appointmentManagementRequests.status, "AWAITING_CONFIRMATION")));
}

export async function handleAppointmentManagementTurn(
  ctx: BookingContext, message: { id: string; body: string }, now = new Date(),
): Promise<AppointmentManagementTurn | null> {
  if (!ctx.conversationId) return null;
  const initialIntent = appointmentManagementIntent(message.body);
  let active = await currentRequest(ctx, now);
  if (/\b(?:don['’]t|do not|not)\s+cancel\b/i.test(message.body)) {
    if (active && active.status !== "EXECUTING") {
      await saveRequest(active, { status: "ABANDONED" }, now);
    }
    return { reply: "Understood. I haven't cancelled or changed your appointment." };
  }
  // An explicit new booking must not inherit a completed or collecting edit.
  if (active && /\b(?:book|schedule|reserve)\s+(?:a|an|another|new)\b/i.test(message.body)) {
    if (active.status !== "EXECUTING") await saveRequest(active, { status: "ABANDONED" }, now);
    return null;
  }
  // Ordinary side questions should remain conversational, not be trapped by a
  // prior appointment-management request.
  if (active && !initialIntent &&
    /\b(?:what services|what do you offer|opening hours|how much|price)\b/i.test(message.body)) return null;
  if (active && !initialIntent && /^(?:thanks|thank you|hello|hi|goodbye|bye)[.! ]*$/i.test(message.body.trim())) return null;
  // The V2 booking engine owns every turn of an unfinished new booking,
  // including ambiguous "cancel my appointment" and subsequent approvals.
  // Do not turn draft-cancellation words into a destructive existing edit.
  if (!active && await hasUnfinishedBooking(ctx, now)) return null;
  if (!active && !initialIntent) {
    if (isExplicitActionConfirmation(message.body)) {
      const [last] = await db.select().from(appointmentManagementRequests)
        .where(and(owned(ctx), eq(appointmentManagementRequests.status, "COMPLETED"),
          gt(appointmentManagementRequests.completedAt, new Date(Date.now() - 5 * 60_000))))
        .orderBy(desc(appointmentManagementRequests.completedAt)).limit(1);
      if (last?.appointmentId) {
        const appointment = await findOwnedAppointment(ctx, last.appointmentId);
        if (appointment) return { reply: "The saved appointment status is: " +
          appointmentLabel(appointment) + " — " + appointment.status.toLowerCase() + ". No additional change was made." };
      }
    }
    return null;
  }
  if (!active && initialIntent === "STATUS") {
    return { reply: statusReply(ctx, await linkedAppointments(ctx, now, true)) };
  }
  if (active?.status === "EXECUTING") {
    return initialIntent || isExplicitActionConfirmation(message.body)
      ? finishRequest(ctx, active, message.id, now)
      : null;
  }
  if (active && /\b(?:no|never mind|nevermind|stop|don['’]t|do not)\b/i.test(message.body)) {
    await saveRequest(active, { status: "ABANDONED" }, now);
    return { reply: "I've stopped the appointment-change request. Your existing appointment has not been changed." };
  }
  if (active && initialIntent === "STATUS") {
    return { reply: active.appointmentId
      ? statusReply(ctx, (await linkedAppointments(ctx, now, true)).filter(row => row.id === active!.appointmentId))
      : statusReply(ctx, await linkedAppointments(ctx, now, true)) };
  }
  if (active && active.status === "AWAITING_CONFIRMATION" && isExplicitActionConfirmation(message.body)) {
    return finishRequest(ctx, active, message.id, now);
  }
  if (active && initialIntent && initialIntent !== active.intent) {
    active = await saveRequest(active, {
      intent: initialIntent, status: "COLLECTING",
      proposedServiceId: null,
      proposedStartsAt: null, proposedEndsAt: null,
      previewDeliveredAt: null, previewDeliveryReference: null,
      localDate: null, localTime: null,
    }, now);
  }
  if (!active) {
    if (!initialIntent || initialIntent === "STATUS") return null;
    if (!await agentAllows(ctx, initialIntent === "CANCEL" ? "CANCEL_APPOINTMENT" : "RESCHEDULE_APPOINTMENT")) {
      return { reply: "I'm not permitted to make that appointment change. I can still answer questions about the business." };
    }
    active = await openRequest(ctx, initialIntent, now);
  }
  const candidates = await linkedAppointments(ctx, now);
  if (!active.appointmentId) {
    if (!candidates.length || candidates.length > 5) {
      await saveRequest(active, { status: "ABANDONED" }, now);
      return { reply: chooseReply(candidates) };
    }
    const selected = selectAppointment(candidates, message.body);
    if (!selected) return { reply: chooseReply(candidates) };
    active = await saveRequest(active, {
      appointmentId: selected.id,
      originalStartsAt: selected.startsAt, originalEndsAt: selected.endsAt,
      originalUpdatedAt: selected.updatedAt, timezone: selected.timezone,
    }, now);
  }
  const appointment = await findOwnedAppointment(ctx, active.appointmentId!);
  if (appointment) {
    const unresolved = await unresolvedChange(ctx, appointment);
    if (unresolved) {
      if (active.status !== "EXECUTING") {
        await saveRequest(active, { status: "ABANDONED" }, now);
      }
      return { reply: unresolved };
    }
  }
  if (!appointment || !EDITABLE_APPOINTMENT.includes(appointment.status as typeof EDITABLE_APPOINTMENT[number])
    || appointment.startsAt <= now) {
    await saveRequest(active, { status: "ABANDONED" }, now);
    return { reply: "The selected appointment is no longer eligible for changes. No new appointment was created." };
  }
  if (active.intent === "CANCEL") {
    active = await saveRequest(active, {
      status: "AWAITING_CONFIRMATION",
      previewDeliveredAt: null, previewDeliveryReference: null,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    }, now);
    return {
      reply: "Please confirm: cancel your existing " + appointmentLabel(appointment) +
        " appointment? Reply YES to cancel the appointment, or NO to leave it unchanged.",
      preview: { requestId: active.id, version: active.version },
    };
  }
  if (!await agentAllows(ctx, "CHECK_AVAILABILITY")) {
    // CHECK_AVAILABILITY is independently revocable.
    return { reply: "I can't check availability at the moment, so I won't change your appointment." };
  }
  const changes = extractRequestedTime(message.body);
  let proposedServiceId = active.proposedServiceId;
  const configured = await db.select().from(services)
    .where(and(eq(services.workspaceId, ctx.workspaceId), eq(services.active, true)))
    .limit(30);
  const mentioned = configured.filter(service =>
    message.body.toLowerCase().includes(service.name.toLowerCase()));
  if (mentioned.length > 1) {
    return { reply: "Which one service would you like for the existing appointment?" };
  }
  if (mentioned.length === 1) {
    const desired = mentioned[0];
    if (desired.name.toLowerCase() !== appointment.title.toLowerCase()) {
      if (appointment.integrationId || appointment.externalEventId) {
        const reply = "Changing the service on this connected calendar appointment needs staff review so both calendars agree. I haven't changed or rebooked your appointment.";
        const agent = await getWorkspaceAgent(ctx.workspaceId);
        if (agent && /escalate/i.test(agent.whenUnsure) &&
          capabilitiesFromBehaviorSettings(agent.behaviorSettings).ESCALATE) {
          try {
            await escalateConversationIssue({
              workspaceId: ctx.workspaceId, conversationId: ctx.conversationId!,
              reason: "Change service on connected appointment " + appointment.id +
                " from " + appointment.title + " to " + desired.name + ".",
            });
            return { reply: reply + " I've flagged that service change for staff follow-up." };
          } catch (error) {
            logger.warn({ err: error, workspaceId: ctx.workspaceId },
              "Appointment service-change escalation failed");
          }
        }
        return { reply };
      }
      if (!desired.durationMinutes || desired.durationMinutes < 5 ||
        desired.durationMinutes > 1440) {
        return { reply: "The requested service needs a valid configured duration. No appointment was changed." };
      }
      proposedServiceId = desired.id;
    } else {
      // The customer corrected a previous service change back to the
      // original service. The old proposal must not survive this correction.
      proposedServiceId = null;
    }
  }
  const selectedService = proposedServiceId
    ? configured.find(service => service.id === proposedServiceId) ?? null
    : null;
  if (proposedServiceId && !selectedService) {
    return { reply: "That service is no longer available. Please choose an active service. Your original appointment is unchanged." };
  }
  let rawTime: ReturnType<typeof parseBookingTime> | null = null;
  try {
    rawTime = changes.time ? parseBookingTime(changes.time) : null;
  } catch (error) {
    return { reply: errorMessage(error) + " Please give a valid appointment start time." };
  }
  const timezone = rawTime?.timezone ?? active.timezone ?? appointment.timezone;
  let localDate = active.localDate;
  let localTime = rawTime?.localTime ?? active.localTime;
  // Changing a service does not imply changing the customer's chosen slot.
  // Retain the time only when the customer expressly asks to keep it.
  if (selectedService && !changes.date && !changes.time &&
    /\b(?:keep|retain|same|current|original)\b/i.test(message.body) &&
    /\b(?:date|time|slot|schedule|appointment)\b/i.test(message.body)) {
    const existingTime = displayBookingInstant(appointment.startsAt, timezone);
    localDate = existingTime.localDate;
    localTime = existingTime.localTime;
  }
  if (changes.date) {
    try { localDate = parseBookingDate(changes.date, timezone, now); }
    catch (error) { return { reply: errorMessage(error) }; }
  }
  if (!localDate || !localTime) {
    active = await saveRequest(active, {
      status: "COLLECTING", localDate, localTime, timezone,
      proposedServiceId, proposedStartsAt: null, proposedEndsAt: null,
      previewDeliveredAt: null, previewDeliveryReference: null,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    }, now);
    return { reply: !localDate
      ? "I found your existing " + appointmentLabel(appointment) +
        ". What date would you like for " +
        (selectedService?.name ?? appointment.title) +
        "? Tell me if you'd prefer to retain its current date and time."
      : "What start time would you prefer on " + localDate +
        "? Your existing " + appointment.title + " appointment has not been changed." };
  }
  const durationMinutes = selectedService?.durationMinutes ??
    (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000;
  let proposed: ReturnType<typeof resolveBookingLocalTime>;
  try {
    proposed = resolveBookingLocalTime({ localDate, localTime, timezone, durationMinutes }, now);
    if (!selectedService && proposed.startsAt.getTime() === appointment.startsAt.getTime() &&
        proposed.endsAt.getTime() === appointment.endsAt.getTime()) {
      return { reply: "That is already your appointment time. What different date or time would you prefer?" };
    }
    await availableForReschedule(ctx, appointment, proposed.startsAt, proposed.endsAt, now);
  } catch (error) {
    await saveRequest(active, {
      status: "COLLECTING", localDate, localTime: null, timezone,
      proposedServiceId, proposedStartsAt: null, proposedEndsAt: null,
      previewDeliveredAt: null, previewDeliveryReference: null,
    }, now);
    return { reply: errorMessage(error) + " Your original appointment is unchanged. What other time would you prefer?" };
  }
  active = await saveRequest(active, {
    status: "AWAITING_CONFIRMATION", localDate, localTime, timezone,
    proposedServiceId,
    proposedStartsAt: proposed.startsAt, proposedEndsAt: proposed.endsAt,
    previewDeliveredAt: null, previewDeliveryReference: null,
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
  }, now);
  return {
    reply: "I checked the calendar. Please confirm: move your existing " +
      appointmentLabel(appointment) + " appointment to " +
      (selectedService ? selectedService.name + " on " : "") +
      humanTime(proposed.startsAt, timezone) + "–" +
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeStyle: "short" }).format(proposed.endsAt) +
      "? Reply YES to reschedule, or tell me another date/time. No new appointment will be created.",
    preview: { requestId: active.id, version: active.version },
  };
}

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bookingDrafts, bookingOffers, bookingPreviews, messages, services } from "@/db/schema";
import { getWorkspaceAgent, requireActiveWorkspaceAgent } from "@/server/agent/service";
import { capabilitiesFromBehaviorSettings } from "@/server/agent/capabilities";
import { escalateConversationIssue } from "@/server/collaboration/service";
import { getBusinessSetup } from "@/server/domain/onboarding/repository";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { generateAIWithUsage } from "@/server/orchestrator/usage";
import { isExplicitActionConfirmation } from "@/server/orchestrator/pending-actions";
import { recordExternalTaskReceipt } from "@/server/orchestrator/task-runs";
import { confirmAndExecuteBooking, getBookingOutcome } from "./commands";
import { getBookingDraft, openBookingDraft, patchBookingDraft, type BookingContext, type BookingPatch } from "./drafts";
import { prepareBookingPreview, searchBookingAvailability, searchBookingRangeAvailability, selectBookingOffer } from "./offers";
import { displayBookingInstant, parseBookingDate, parseBookingTime, type BookingSearchPeriod } from "./time";

const intent = z.object({
  action: z.enum(["PATCH", "CANCEL", "QUESTION", "UNRELATED", "STATUS", "CHECK", "SELECT"]),
  offerId: z.string().uuid().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  dateExpression: z.string().trim().min(1).max(200).optional(),
  timeExpression: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().min(1).max(2000).nullable().optional(),
  question: z.string().trim().max(500).optional(),
  range: z.enum(["DAY", "MORNING", "AFTERNOON", "EVENING", "NEXT_AVAILABLE"]).optional(),
}).strict();

export type BookingTurn = {
  reply: string;
  preview?: { draftId: string; previewId: string; version: number };
};

function humanTime(instant: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, dateStyle: "full", timeStyle: "short",
  }).format(instant);
}

function errorReply(error: unknown) {
  if (error instanceof AppError && error.status < 500) return error.message;
  logger.error({ err: error }, "Booking conversation failed without a confirmed result");
  return "I couldn't complete that appointment request right now. I haven't confirmed a new booking.";
}

const CUSTOMER_RECOVERABLE_BOOKING_ERRORS = new Set([
  "BOOKING_INTENT_UNCLEAR", "BOOKING_DETAILS_REQUIRED", "BOOKING_SERVICE_REQUIRED",
  "BOOKING_SERVICE_UNAVAILABLE", "BOOKING_STALE_VERSION", "BOOKING_DRAFT_NOT_EDITABLE",
  "BOOKING_PREVIEW_STALE", "BOOKING_OFFER_STALE", "BOOKING_CONFIRMATION_REQUIRED",
  "BOOKING_CONFIRMATION_EVIDENCE_REQUIRED", "BOOKING_CONFIRMATION_SESSION_MISMATCH",
  "APPOINTMENT_SLOT_UNAVAILABLE", "BOOKING_SOURCE_EVENT_CONFLICT",
  "BOOKING_DATE_INVALID", "BOOKING_DATE_UNRECOGNIZED", "BOOKING_DATE_AMBIGUOUS",
  "BOOKING_TIME_INVALID", "BOOKING_TIME_UNRECOGNIZED", "BOOKING_WEEKDAY_MISMATCH",
  "BOOKING_LOCAL_TIME_NONEXISTENT", "BOOKING_LOCAL_TIME_AMBIGUOUS", "APPOINTMENT_IN_PAST",
]);

async function bookingFailureReply(context: BookingContext, error: unknown) {
  const reply = errorReply(error);
  const code = error instanceof AppError ? error.code : "BOOKING_OPERATIONAL_FAILURE";
  if (CUSTOMER_RECOVERABLE_BOOKING_ERRORS.has(code) || !context.conversationId) return reply;
  try {
    const agent = await getWorkspaceAgent(context.workspaceId);
    if (!agent || !/escalate/i.test(agent.whenUnsure)) return reply;
    const capabilities = capabilitiesFromBehaviorSettings(agent.behaviorSettings);
    if (!capabilities.ESCALATE) return reply;
    await escalateConversationIssue({
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      reason: "Appointment booking needs staff follow-up (" + code.slice(0, 80) + ").",
    });
    return reply + " I've flagged this appointment issue for staff follow-up. I can keep helping with anything else.";
  } catch (escalationError) {
    logger.error({ err: escalationError, workspaceId: context.workspaceId,
      conversationId: context.conversationId },
    "Booking failed and configured staff follow-up could not be recorded");
    return reply;
  }
}

async function recordBookingTaskReceipt(
  context: BookingContext,
  draftId: string,
  sourceMessageId: string,
  action: "CHECK_AVAILABILITY" | "BOOK_APPOINTMENT",
  actionInput: Record<string, unknown>,
  result: {
    kind: "availability" | "booking" | "pending_action";
    data: Record<string, unknown>;
  },
  idempotencyKey: string,
) {
  if (!context.conversationId) return;
  await recordExternalTaskReceipt({
    workspaceId: context.workspaceId,
    conversationId: context.conversationId,
    contactId: context.contactId,
    taskKey: `booking:${draftId}`,
    sourceMessageId,
    objective: "Book appointment",
    action,
    actionInput,
    result,
    idempotencyKey,
    metadata: {
      channel: context.channel,
      sessionKey: context.sessionKey,
      bookingDraftId: draftId,
    },
  });
}

function previewReply(preview: typeof bookingPreviews.$inferSelect) {
  const content = preview.content;
  const start = new Date(String(content.startsAt));
  const end = new Date(String(content.endsAt));
  const timezone = String(content.timezone);
  const location = typeof content.requiredLocation === "string" ? content.requiredLocation : null;
  return [
    "I checked the schedule. This appointment time is available:",
    String(content.serviceName),
    humanTime(start, timezone) + "–" + new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, timeStyle: "short",
    }).format(end) + " (" + timezone + ")",
    location ? "Location: " + location : "",
    "Shall I book this exact appointment?",
  ].filter(Boolean).join("\n");
}

async function classifyBookingTurn(
  context: BookingContext, message: string, draft: typeof bookingDrafts.$inferSelect | null,
  timezone: string,
  offers: typeof bookingOffers.$inferSelect[] = [],
) {
  const list = await db.select({ id: services.id, name: services.name,
    durationMinutes: services.durationMinutes, priceText: services.priceText })
    .from(services).where(and(eq(services.workspaceId, context.workspaceId),
      eq(services.active, true))).limit(30);
  const system = [
    "Extract the customer's latest booking intent. Output ONLY one JSON object; no markdown or extra keys.",
    'Shape: {"action":"PATCH|CANCEL|QUESTION|UNRELATED|STATUS|CHECK|SELECT"}. Add only present fields: serviceId, dateExpression, timeExpression, timezone, location, question, range, offerId.',
    "Omit fields not supplied. Never invent dates or timezones. Never turn a question or a yes-but-correction into booking consent.",
    "A bare yes after a question about checking is not a booking confirmation.",
    "Use PATCH for newly supplied service/date/time/location or corrections. CHECK if the customer requests availability of an unchanged draft.",
    'When the customer asks for a whole day, morning, afternoon, evening, or next available without an exact time, set range to DAY, MORNING, AFTERNOON, EVENING, or NEXT_AVAILABLE. Do not invent a start time.',
    "Use QUESTION for a side question. Use UNRELATED when there is no booking intent and no booking field or question.",
    "Use STATUS for an inquiry about an existing booking outcome. CANCEL cancels only an unfinished draft.",
    "Return a serviceId only for one clearly identified service. Otherwise omit it and let the backend clarify.",
    "Use SELECT with an offerId from the offered list when the customer chooses an offered time or ordinal. Selection is not consent to commit. Do not reconstruct a selected slot's dates or times.",
    "Preserve expressions exactly as spoken: 'Sep 23, 2026', '11 AM (Africa/Lagos)', '10 am UTC' are separate valid date/time expressions.",
    "Business timezone is " + timezone + ". Never calculate UTC or service duration.",
    "Services: " + JSON.stringify(list),
    "Offered times (in display order): " + JSON.stringify(offers.map(offer => ({
      offerId: offer.id, ...displayBookingInstant(offer.startsAt, offer.timezone),
    }))),
    "Stored draft (trusted): " + JSON.stringify(draft && {
      serviceId: draft.serviceId, localDate: draft.localDate, localTime: draft.localTime,
      customerTimezone: draft.customerTimezone, requiredLocation: draft.requiredLocation,
      status: draft.status,
    }),
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = await generateAIWithUsage(context.workspaceId,
      context.conversationId ?? context.sessionKey,
      [{ role: "system", content: system + (attempt === 1
        ? "\nYour previous output failed JSON/schema validation. Output only the specified JSON object." : "") },
      { role: "user", content: message }]);
    const raw = generated.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/,"");
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { continue; }
    // Models commonly fill optional keys with null. Treat these as absent, not
    // as requests to erase previously captured date, service or timezone.
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      decoded = Object.fromEntries(Object.entries(decoded).filter(([, value]) => value !== null));
    }
    const parsed = intent.safeParse(decoded);
    if (parsed.success) return { intent: parsed.data, services: list };
  }
  throw new AppError("BOOKING_INTENT_UNCLEAR",
    "I couldn't reliably understand the appointment details. Could you say the date and time again?", 422);
}

async function activeDraft(ctx: BookingContext) {
  const [draft] = await db.select().from(bookingDrafts).where(and(
    eq(bookingDrafts.workspaceId, ctx.workspaceId),
    eq(bookingDrafts.contactId, ctx.contactId),
    eq(bookingDrafts.sessionKey, ctx.sessionKey),
    eq(bookingDrafts.channel, ctx.channel),
    inArray(bookingDrafts.status, ["COLLECTING", "AVAILABILITY_CHECKED", "AWAITING_CONFIRMATION", "COMMITTING", "RECONCILING"]),
  )).orderBy(desc(bookingDrafts.createdAt)).limit(1);
  return draft ?? null;
}

export async function handleBookingTurn(
  ctx: BookingContext,
  message: { id: string; body: string },
  now = new Date(),
  isCurrentTurn?: () => Promise<boolean>,
): Promise<BookingTurn | null> {
  if (isCurrentTurn && !await isCurrentTurn()) return { reply: "I heard a correction; let me use your latest request." };
  const agent = await getWorkspaceAgent(ctx.workspaceId);
  if (!agent || agent.status !== "ACTIVE" ||
    !capabilitiesFromBehaviorSettings(agent.behaviorSettings).ANSWER_INQUIRY) return null;
  const active = await activeDraft(ctx);
  const existing = active && (active.expiresAt > now || active.bookingCommandId) ? active : null;
  const approval = isExplicitActionConfirmation(message.body);
  const statusQuestion = /\b(?:is it booked|did you book|booking status|appointment status|is it confirmed)\b/i.test(message.body);
  // A completed draft must remain reachable. Falling back to the legacy model
  // after success loses the receipt and can propose a second appointment.
  const [completed] = !existing && (approval || statusQuestion) ? await db.select().from(bookingDrafts).where(and(
    eq(bookingDrafts.workspaceId, ctx.workspaceId), eq(bookingDrafts.contactId, ctx.contactId),
    eq(bookingDrafts.sessionKey, ctx.sessionKey), eq(bookingDrafts.channel, ctx.channel),
    eq(bookingDrafts.status, "CONFIRMED"),
  )).orderBy(desc(bookingDrafts.createdAt)).limit(1) : [];
  const receiptDraft = completed ?? (existing?.bookingCommandId ? existing : null);
  if (receiptDraft && (approval || statusQuestion)) {
    const result = await getBookingOutcome(ctx, receiptDraft.id);
    const appointment = result.appointment;
    const timezone = receiptDraft.customerTimezone ?? appointment?.timezone ?? "UTC";
    if (appointment) {
      await recordBookingTaskReceipt(
        ctx,
        receiptDraft.id,
        message.id,
        "BOOK_APPOINTMENT",
        { draftId: receiptDraft.id },
        {
          kind: "booking",
          data: {
            appointmentId: appointment.id,
            title: appointment.title,
            startsAt: appointment.startsAt.toISOString(),
            endsAt: appointment.endsAt.toISOString(),
            timezone: appointment.timezone,
            status: appointment.status,
          },
        },
        `booking-confirmed:${appointment.id}`,
      );
    } else if (result.state === "COMMITTING" || result.state === "RECONCILING") {
      await recordBookingTaskReceipt(
        ctx,
        receiptDraft.id,
        message.id,
        "BOOK_APPOINTMENT",
        { draftId: receiptDraft.id },
        { kind: "booking", data: { state: result.state, status: result.state } },
        `booking-outcome:${receiptDraft.id}:${result.state}:${message.id}`,
      );
    }
    return { reply: appointment
      ? "Your " + appointment.title + " appointment is confirmed for " + humanTime(appointment.startsAt, timezone) + " (" + timezone + ")."
      : "I'm still checking the saved booking result. I haven't confirmed it yet; please don't submit another booking." };
  }
  const isBookingRequest = /\b(?:book(?:ing)?|appointment|schedule|availability|available|reserve|reschedule)\b/i.test(message.body);
  if (!existing && !isBookingRequest) return null;
  const offers = existing?.currentSearchId && !existing.currentPreviewId
    ? await db.select().from(bookingOffers).where(and(
      eq(bookingOffers.workspaceId, ctx.workspaceId), eq(bookingOffers.draftId, existing.id),
      eq(bookingOffers.searchId, existing.currentSearchId),
    )).orderBy(asc(bookingOffers.startsAt), asc(bookingOffers.id)).limit(5) : [];
  const selectedReply = async (offerId: string): Promise<BookingTurn> => {
    const selected = await selectBookingOffer(ctx, {
      draftId: existing!.id, expectedVersion: existing!.version, offerId,
    }, now);
    const prepared = await prepareBookingPreview(ctx, {
      draftId: existing!.id, expectedVersion: selected.draft.version,
    }, now);
    await recordBookingTaskReceipt(
      ctx,
      existing!.id,
      message.id,
      "BOOK_APPOINTMENT",
      {
        draftId: existing!.id,
        offerId,
        previewId: prepared.preview.id,
      },
      {
        kind: "pending_action",
        data: {
          pendingActionId: prepared.preview.id,
          type: "BOOK_APPOINTMENT",
          ...prepared.preview.content,
        },
      },
      `booking-preview:${prepared.preview.id}`,
    );
    return { reply: previewReply(prepared.preview), preview: {
      draftId: existing!.id, previewId: prepared.preview.id, version: selected.draft.version,
    } };
  };
  if (offers.length && approval) {
    if (offers.length > 1) return { reply: "Which of the offered times would you like? You can say the first one or give its date and time." };
    try { return await selectedReply(offers[0].id); }
    catch (error) { return { reply: await bookingFailureReply(ctx, error) }; }
  }
  // A no/yes answer to unrelated questions is not authority to commit.
  if (existing?.currentPreviewId && isExplicitActionConfirmation(message.body)) {
    if (isCurrentTurn && !await isCurrentTurn()) return { reply: "The booking changed; I haven't confirmed it." };
    const [preview] = await db.select().from(bookingPreviews).where(and(
      eq(bookingPreviews.id, existing.currentPreviewId),
      eq(bookingPreviews.workspaceId, ctx.workspaceId),
      eq(bookingPreviews.draftId, existing.id),
    )).limit(1);
    if (preview?.deliveredAt) {
      try {
        const result = await confirmAndExecuteBooking(ctx, {
          draftId: existing.id, expectedVersion: existing.version,
          previewId: preview.id, sourceEventId: message.id,
        }, now);
        if (result.state === "CONFIRMED") {
          const state = await getBookingOutcome(ctx, existing.id);
          const appointment = state.appointment;
          if (appointment) {
            await recordBookingTaskReceipt(
              ctx,
              existing.id,
              message.id,
              "BOOK_APPOINTMENT",
              {
                draftId: existing.id,
                previewId: preview.id,
              },
              {
                kind: "booking",
                data: {
                  appointmentId: appointment.id,
                  title: appointment.title,
                  startsAt: appointment.startsAt.toISOString(),
                  endsAt: appointment.endsAt.toISOString(),
                  timezone: appointment.timezone,
                  status: appointment.status,
                },
              },
              `booking-confirmed:${appointment.id}`,
            );
          }
          return {
            reply: appointment
              ? "Your " + appointment.title + " appointment is confirmed for " +
                humanTime(appointment.startsAt, preview.content.timezone as string) +
                " (" + preview.content.timezone + ")."
              : "I'm still verifying the appointment receipt. I can't confirm that it's booked yet.",
          };
        }
        await recordBookingTaskReceipt(
          ctx,
          existing.id,
          message.id,
          "BOOK_APPOINTMENT",
          {
            draftId: existing.id,
            previewId: preview.id,
          },
          {
            kind: "booking",
            data: { state: result.state, status: result.state },
          },
          `booking-outcome:${existing.id}:${result.state}:${message.id}`,
        );
        return { reply: result.state === "FAILED"
          ? "I could not complete the appointment. I haven't booked another time."
          : "I'm checking the final booking status. Please don't submit the appointment again; I can check its saved result." };
      } catch (error) {
        return { reply: await bookingFailureReply(ctx, error) };
      }
    }
  }
  if (existing && /\b(?:is it booked|did you book|booking status|appointment status)\b/i.test(message.body)) {
    const outcome = await getBookingOutcome(ctx, existing.id);
    const appointment = outcome.appointment;
    return { reply: appointment
      ? "Your " + appointment.title + " appointment is confirmed for " +
        humanTime(appointment.startsAt, appointment.timezone) + " (" + appointment.timezone + ")."
      : outcome.state === "RECONCILING" || outcome.state === "COMMITTING"
        ? "The booking is still being verified. I haven't confirmed it yet."
        : "I don't have a confirmed booking for this request yet." };
  }
  let parsed: Awaited<ReturnType<typeof classifyBookingTurn>>;
  try {
    const business = await getBusinessSetup(ctx.workspaceId);
    parsed = await classifyBookingTurn(ctx, message.body, existing,
      business.profile?.timezone ?? "UTC", offers);
  } catch (error) {
    return { reply: await bookingFailureReply(ctx, error) };
  }
  const decision = parsed.intent;
  if (isCurrentTurn && !await isCurrentTurn()) return { reply: "I heard a correction; let me use your latest request." };
  if (decision.action === "SELECT") {
    if (!existing || !offers.some(offer => offer.id === decision.offerId)) {
      return { reply: "Please choose one of the current offered times, or tell me the date and time you'd prefer." };
    }
    try { return await selectedReply(decision.offerId!); }
    catch (error) { return { reply: await bookingFailureReply(ctx, error) }; }
  }
  if (decision.action === "UNRELATED" || decision.action === "QUESTION") {
    const service = parsed.services.find((item) => item.id === existing?.serviceId);
    if (service && /\b(?:how long|duration)\b/i.test(message.body)) {
      return { reply: service.name + " takes " + service.durationMinutes + " minutes. What else would you like to know?" };
    }
    if (service?.priceText && /\b(?:price|cost|how much)\b/i.test(message.body)) {
      return { reply: service.name + " costs " + service.priceText + ". What else would you like to know?" };
    }
    return null; // Leave ordinary questions to the existing agent; draft persists.
  }
  if (decision.action === "STATUS") {
    const outcome = existing ? await getBookingOutcome(ctx, existing.id) : null;
    return { reply: outcome?.appointment
      ? "Your appointment is confirmed for " +
        humanTime(outcome.appointment.startsAt, outcome.appointment.timezone) +
        " (" + outcome.appointment.timezone + ")."
      : "I haven't confirmed a new appointment in this booking session yet." };
  }
  if (decision.action === "CANCEL") {
    if (!existing) return { reply: "There is no unfinished booking to cancel." };
    const { cancelBookingDraft } = await import("./drafts");
    try {
      await cancelBookingDraft(ctx, {
        draftId: existing.id, expectedVersion: existing.version, sourceEventId: message.id,
      }, now);
      return { reply: "I've cancelled the unfinished appointment request. No appointment was created." };
    } catch (error) { return { reply: await bookingFailureReply(ctx, error) }; }
  }
  try {
    await requireActiveWorkspaceAgent(ctx.workspaceId, "CHECK_AVAILABILITY");
    const opened = existing
      ? { draft: existing }
      : await openBookingDraft(ctx, now);
    if (!("draft" in opened)) throw new AppError("BOOKING_STATE_UNAVAILABLE", "Booking draft could not be created.", 503);
    const draft = opened.draft;
    const patch: BookingPatch = {};
    if (decision.serviceId !== undefined) patch.serviceId = decision.serviceId;
    // Interpret relative dates in the timezone explicitly spoken alongside
    // the new time, not the stale business/default zone from an earlier turn.
    const parsedTime = decision.timeExpression
      ? parseBookingTime(decision.timeExpression) : null;
    const tz = decision.timezone ?? parsedTime?.timezone ?? draft.customerTimezone ??
      (await getBusinessSetup(ctx.workspaceId)).profile?.timezone ?? "UTC";
    if (decision.dateExpression) {
      patch.localDate = parseBookingDate(decision.dateExpression, tz, now);
      patch.originalDateExpression = decision.dateExpression;
    }
    if (parsedTime) {
      patch.localTime = parsedTime.localTime;
      if (parsedTime.timezone) patch.customerTimezone = parsedTime.timezone;
    }
    if (decision.timezone) patch.customerTimezone = decision.timezone;
    if (!draft.customerTimezone && !patch.customerTimezone) patch.customerTimezone = tz;
    if (decision.location !== undefined) patch.requiredLocation = decision.location;
    if (decision.range === "NEXT_AVAILABLE" && !decision.dateExpression && !draft.localDate) {
      patch.localDate = displayBookingInstant(now, tz).localDate;
      patch.originalDateExpression = "next available";
    }
    const updated = Object.keys(patch).length
      ? await patchBookingDraft(ctx, {
        draftId: draft.id, expectedVersion: draft.version,
        sourceEventId: message.id, patch,
      }, now)
      : null;
    const current = updated?.state === "UPDATED" || updated?.state === "UNCHANGED"
      ? updated.draft : await getBookingDraft(ctx, draft.id);
    if (!current.serviceId) return { reply: "Which service would you like to book?" };
    if (!current.localDate) return { reply: "What date would you prefer for the appointment?" };
    if (!current.localTime && decision.range) {
      const ranged = await searchBookingRangeAvailability(ctx, {
        draftId: draft.id, expectedVersion: current.version,
        period: decision.range as BookingSearchPeriod,
      }, now);
      await recordBookingTaskReceipt(
        ctx,
        draft.id,
        message.id,
        "CHECK_AVAILABILITY",
        {
          draftId: draft.id,
          period: decision.range,
          version: current.version,
        },
        {
          kind: "availability",
          data: {
            state: ranged.state,
            slots: ranged.offers.map((offer) => ({
              offerId: offer.id,
              startsAt: offer.startsAt.toISOString(),
              endsAt: offer.endsAt.toISOString(),
              timezone: offer.timezone,
            })),
          },
        },
        `availability-range:${draft.id}:${current.version}:${decision.range}:${message.id}`,
      );
      if (!ranged.offers.length) {
        return { reply: "I checked that time range and found no available appointment slots. Would you like another date or time range?" };
      }
      const shown = ranged.offers.slice(0, 5).map((offer) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: offer.timezone, dateStyle: "medium", timeStyle: "short",
        }).format(offer.startsAt) + " (" + offer.timezone + ")").join("; ");
      return { reply: "Available times include: " + shown +
        ". Tell me the start time you prefer and I'll prepare the exact appointment for confirmation." };
    }
    if (!current.localTime) return { reply: "What start time would you prefer?" };
    // Rechecking also renews the offer/version and delivery evidence. Never
    // resend an old preview with a different outbound confirmation question.
    const found = await searchBookingAvailability(ctx, {
      draftId: draft.id, expectedVersion: current.version,
    }, now);
    await recordBookingTaskReceipt(
      ctx,
      draft.id,
      message.id,
      "CHECK_AVAILABILITY",
      {
        draftId: draft.id,
        version: current.version,
      },
      {
        kind: "availability",
        data: {
          state: found.state,
          slots: found.offers.map((offer) => ({
            offerId: offer.id,
            startsAt: offer.startsAt.toISOString(),
            endsAt: offer.endsAt.toISOString(),
            timezone: offer.timezone,
          })),
        },
      },
      `availability-exact:${draft.id}:${current.version}:${message.id}`,
    );
    if (!found.offers.length) {
      return { reply: "I checked the calendar and that exact time is unavailable. Would you like to try another date or time?" };
    }
    if (isCurrentTurn && !await isCurrentTurn()) return { reply: "I heard a correction; let me check the latest time." };
    const selected = await selectBookingOffer(ctx, {
      draftId: draft.id, expectedVersion: found.version, offerId: found.offers[0].id,
    }, now);
    const prepared = await prepareBookingPreview(ctx, {
      draftId: draft.id, expectedVersion: selected.draft.version,
    }, now);
    await recordBookingTaskReceipt(
      ctx,
      draft.id,
      message.id,
      "BOOK_APPOINTMENT",
      {
        draftId: draft.id,
        offerId: selected.offer.id,
        previewId: prepared.preview.id,
      },
      {
        kind: "pending_action",
        data: {
          pendingActionId: prepared.preview.id,
          type: "BOOK_APPOINTMENT",
          ...prepared.preview.content,
        },
      },
      `booking-preview:${prepared.preview.id}`,
    );
    return { reply: previewReply(prepared.preview),
      preview: { draftId: draft.id, previewId: prepared.preview.id,
        version: selected.draft.version } };
  } catch (error) {
    return { reply: await bookingFailureReply(ctx, error) };
  }
}

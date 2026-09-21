import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bookingDrafts, bookingPreviews, messages, services } from "@/db/schema";
import { requireActiveWorkspaceAgent } from "@/server/agent/service";
import { getBusinessSetup } from "@/server/domain/onboarding/repository";
import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { generateAIWithUsage } from "@/server/orchestrator/usage";
import { isExplicitActionConfirmation } from "@/server/orchestrator/pending-actions";
import { confirmAndExecuteBooking, getBookingOutcome } from "./commands";
import { getBookingDraft, openBookingDraft, patchBookingDraft, type BookingContext, type BookingPatch } from "./drafts";
import { prepareBookingPreview, searchBookingAvailability, selectBookingOffer } from "./offers";
import { parseBookingDate, parseBookingTime } from "./time";

const intent = z.object({
  action: z.enum(["PATCH", "CANCEL", "QUESTION", "UNRELATED", "STATUS", "CHECK"]),
  serviceId: z.string().uuid().nullable().optional(),
  dateExpression: z.string().trim().min(1).max(200).optional(),
  timeExpression: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().min(1).max(2000).nullable().optional(),
  question: z.string().trim().max(500).optional(),
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
) {
  const list = await db.select({ id: services.id, name: services.name,
    durationMinutes: services.durationMinutes, priceText: services.priceText })
    .from(services).where(and(eq(services.workspaceId, context.workspaceId),
      eq(services.active, true))).limit(30);
  const system = [
    "Extract the customer's latest booking intent. Output ONLY one JSON object; no markdown or extra keys.",
    'Shape: {"action":"PATCH|CANCEL|QUESTION|UNRELATED|STATUS|CHECK","serviceId":null,"dateExpression":null,"timeExpression":null,"timezone":null,"location":null,"question":null}.',
    "Omit fields not supplied. Never invent dates or timezones. Never turn a question or a yes-but-correction into booking consent.",
    "A bare yes after a question about checking is not a booking confirmation.",
    "Use PATCH for newly supplied service/date/time/location or corrections. CHECK if the customer requests availability of an unchanged draft.",
    "Use QUESTION for a side question. Use UNRELATED when there is no booking intent and no booking field or question.",
    "Use STATUS for an inquiry about an existing booking outcome. CANCEL cancels only an unfinished draft.",
    "Return a serviceId only for one clearly identified service. Otherwise omit it and let the backend clarify.",
    "Preserve expressions exactly as spoken: 'Sep 23, 2026', '11 AM (Africa/Lagos)', '10 am UTC' are separate valid date/time expressions.",
    "Business timezone is " + timezone + ". Never calculate UTC or service duration.",
    "Services: " + JSON.stringify(list),
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
): Promise<BookingTurn | null> {
  const existing = await activeDraft(ctx);
  const isBookingRequest = /\b(?:book(?:ing)?|appointment|schedule|availability|available|reserve|reschedule)\b/i.test(message.body);
  if (!existing && !isBookingRequest) return null;
  // A no/yes answer to unrelated questions is not authority to commit.
  if (existing?.currentPreviewId && isExplicitActionConfirmation(message.body)) {
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
          return {
            reply: appointment
              ? "Your " + appointment.title + " appointment is confirmed for " +
                humanTime(appointment.startsAt, preview.content.timezone as string) +
                " (" + preview.content.timezone + ")."
              : "Your appointment is confirmed. You can view the receipt in Appointments.",
          };
        }
        return { reply: result.state === "FAILED"
          ? "I could not complete the appointment. I haven't booked another time."
          : "I'm checking the final booking status. Please don't submit the appointment again; I can check its saved result." };
      } catch (error) {
        return { reply: errorReply(error) };
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
      business.profile?.timezone ?? "UTC");
  } catch (error) {
    return { reply: errorReply(error) };
  }
  const decision = parsed.intent;
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
    } catch (error) { return { reply: errorReply(error) }; }
  }
  try {
    await requireActiveWorkspaceAgent(ctx.workspaceId, "CHECK_AVAILABILITY");
    const opened = existing
      ? { draft: existing }
      : await openBookingDraft(ctx, now);
    const draft = opened.draft;
    const patch: BookingPatch = {};
    if (decision.serviceId !== undefined) patch.serviceId = decision.serviceId;
    const tz = decision.timezone ?? draft.customerTimezone ??
      (await getBusinessSetup(ctx.workspaceId)).profile?.timezone ?? "UTC";
    if (decision.dateExpression) {
      patch.localDate = parseBookingDate(decision.dateExpression, tz, now);
      patch.originalDateExpression = decision.dateExpression;
    }
    if (decision.timeExpression) {
      const time = parseBookingTime(decision.timeExpression);
      patch.localTime = time.localTime;
      if (time.timezone) patch.customerTimezone = time.timezone;
    }
    if (decision.timezone) patch.customerTimezone = decision.timezone;
    if (decision.location !== undefined) patch.requiredLocation = decision.location;
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
    if (!current.localTime) return { reply: "What start time would you prefer?" };
    if (current.status === "AWAITING_CONFIRMATION" && current.currentPreviewId) {
      const [preview] = await db.select().from(bookingPreviews).where(and(
        eq(bookingPreviews.id, current.currentPreviewId),
        eq(bookingPreviews.workspaceId, ctx.workspaceId),
      )).limit(1);
      if (preview && preview.expiresAt > now) return { reply: previewReply(preview) };
    }
    const found = await searchBookingAvailability(ctx, {
      draftId: draft.id, expectedVersion: current.version,
    }, now);
    if (!found.offers.length) {
      return { reply: "I checked the calendar and that exact time is unavailable. Would you like to try another date or time?" };
    }
    const selected = await selectBookingOffer(ctx, {
      draftId: draft.id, expectedVersion: found.version, offerId: found.offers[0].id,
    }, now);
    const prepared = await prepareBookingPreview(ctx, {
      draftId: draft.id, expectedVersion: selected.draft.version,
    }, now);
    return { reply: previewReply(prepared.preview),
      preview: { draftId: draft.id, previewId: prepared.preview.id,
        version: selected.draft.version } };
  } catch (error) {
    return { reply: errorReply(error) };
  }
}

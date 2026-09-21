import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bookingDrafts, bookingOffers, bookingPreviews, messages, services } from "@/db/schema";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { getBusinessSetup } from "@/server/domain/onboarding/repository";
import { getCalendarSetup } from "@/server/domain/integrations/repository";
import { AppError } from "@/server/http/errors";
import { resolveProviderRoute } from "@/server/providers/resolver";
import { displayBookingInstant, resolveBookingLocalTime } from "./time";
import { getBookingDraft, type BookingContext } from "./drafts";

const idSchema = z.string().uuid();
const versionSchema = z.number().int().positive();
const OFFER_TTL_MS = 5 * 60_000;
type BookingOffer = typeof bookingOffers.$inferSelect;

export async function currentBookingBinding(workspaceId: string, service: typeof services.$inferSelect) {
  const route = await resolveProviderRoute(workspaceId, "CALENDAR");
  const [business, calendar] = await Promise.all([
    getBusinessSetup(workspaceId), getCalendarSetup(workspaceId),
  ]);
  if (!business.profile) {
    throw new AppError("BUSINESS_HOURS_NOT_CONFIGURED", "Set business hours before checking appointments.", 409);
  }
  const provider = route?.mode === "BYOP" && route.integrationId ? route.provider : "native";
  const integrationId = provider === "native" ? null : route!.integrationId;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    provider, integrationId, integrationSettings: route?.settings ?? null,
    businessTimezone: business.profile.timezone, businessHours: business.hours,
    calendar, service: { id: service.id, active: service.active, name: service.name,
      duration: service.durationMinutes, updatedAt: service.updatedAt },
  })).digest("hex");
  return { provider, integrationId, fingerprint, businessTimezone: business.profile.timezone };
}

export async function requireBookingService(workspaceId: string, serviceId: string | null) {
  if (!serviceId) throw new AppError("BOOKING_SERVICE_REQUIRED", "Which service would you like to book?", 422);
  const [service] = await db.select().from(services).where(and(
    eq(services.id, serviceId), eq(services.workspaceId, workspaceId),
  )).limit(1);
  if (!service || !service.active) throw new AppError("BOOKING_SERVICE_UNAVAILABLE", "This service is not available for booking.", 409);
  if (service.durationMinutes === null || !Number.isSafeInteger(service.durationMinutes) ||
    service.durationMinutes < 5 || service.durationMinutes > 1440) {
    throw new AppError("BOOKING_DURATION_UNCONFIGURED", "Set a valid service duration before accepting bookings.", 409);
  }
  return service;
}

function owned(context: BookingContext, draftId: string) {
  return and(
    eq(bookingDrafts.id, draftId), eq(bookingDrafts.workspaceId, context.workspaceId),
    eq(bookingDrafts.contactId, context.contactId),
    eq(bookingDrafts.sessionKey, context.sessionKey),
    eq(bookingDrafts.channel, context.channel),
  );
}

async function lock(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], context: BookingContext) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${context.workspaceId + ":" + context.sessionKey}))`);
}

async function currentDraft(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  context: BookingContext, draftId: string, expectedVersion: number, now: Date,
) {
  const [draft] = await tx.select().from(bookingDrafts).where(owned(context, draftId)).limit(1);
  if (!draft) throw new AppError("BOOKING_NOT_FOUND", "Booking session not found.", 404);
  if (draft.version !== expectedVersion) {
    throw new AppError("BOOKING_STALE_VERSION", "The appointment details have changed.", 409);
  }
  if (draft.expiresAt <= now ||
    !["COLLECTING", "AVAILABILITY_CHECKED", "AWAITING_CONFIRMATION"].includes(draft.status)) {
    throw new AppError("BOOKING_DRAFT_NOT_EDITABLE", "The booking is no longer editable.", 409);
  }
  return draft;
}

// An exact check always covers the full service duration and preserves the
// binding used by the authoritative calendar check.
export async function searchBookingAvailability(
  context: BookingContext,
  input: { draftId: string; expectedVersion: number },
  now = new Date(),
): Promise<{ state: "SLOTS_AVAILABLE" | "NO_SLOTS"; offers: BookingOffer[]; version: number }> {
  const draftId = idSchema.parse(input.draftId), version = versionSchema.parse(input.expectedVersion);
  const draft = await getBookingDraft(context, draftId);
  if (draft.version !== version || draft.expiresAt <= now ||
    !["COLLECTING", "AVAILABILITY_CHECKED", "AWAITING_CONFIRMATION"].includes(draft.status)) {
    throw new AppError("BOOKING_STALE_VERSION", "The booking changed before availability could be checked.", 409);
  }
  if (!draft.localDate || !draft.localTime) {
    throw new AppError("BOOKING_DETAILS_REQUIRED", "Please supply an appointment date and start time.", 422);
  }
  const service = await requireBookingService(context.workspaceId, draft.serviceId);
  const before = await currentBookingBinding(context.workspaceId, service);
  const timezone = draft.customerTimezone ?? before.businessTimezone;
  const resolved = resolveBookingLocalTime({
    localDate: draft.localDate, localTime: draft.localTime,
    timezone, durationMinutes: service.durationMinutes!,
  }, now);
  const query = { startsAt: resolved.startsAt, endsAt: resolved.endsAt,
    timezone, durationMinutes: service.durationMinutes! };
  const found = await calendarBookingService.getAvailability(context.workspaceId, query);
  const after = await currentBookingBinding(context.workspaceId, service);
  if (before.fingerprint !== after.fingerprint) {
    throw new AppError("BOOKING_BINDING_CHANGED", "Calendar settings changed. Please check availability again.", 409);
  }
  const matching = found.slots.filter((slot) =>
    slot.startsAt.getTime() === resolved.startsAt.getTime() &&
    slot.endsAt.getTime() === resolved.endsAt.getTime());
  const searchId = randomUUID();
  return db.transaction(async (tx) => {
    await lock(tx, context);
    await currentDraft(tx, context, draftId, version, now);
    // Late provider responses must not overwrite a newer customer correction.
    const [updated] = await tx.update(bookingDrafts).set({
      status: "AVAILABILITY_CHECKED", currentSearchId: searchId,
      selectedOfferId: null, currentPreviewId: null, updatedAt: now,
    }).where(and(owned(context, draftId), eq(bookingDrafts.version, version))).returning();
    if (!updated) throw new AppError("BOOKING_STALE_VERSION", "The booking has changed.", 409);
    if (!matching.length) return { state: "NO_SLOTS", offers: [], version: updated.version };
    const offers = await tx.insert(bookingOffers).values(matching.map((slot) => ({
      workspaceId: context.workspaceId, draftId, draftVersion: version,
      searchId, serviceId: service.id, durationMinutes: service.durationMinutes!,
      provider: before.provider, integrationId: before.integrationId,
      bindingFingerprint: before.fingerprint,
      startsAt: slot.startsAt, endsAt: slot.endsAt, timezone,
      checkedAt: now, expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    }))).returning();
    return { state: "SLOTS_AVAILABLE", offers, version: updated.version };
  });
}

export async function selectBookingOffer(
  context: BookingContext,
  input: { draftId: string; expectedVersion: number; offerId: string },
  now = new Date(),
) {
  const draftId = idSchema.parse(input.draftId), offerId = idSchema.parse(input.offerId);
  const version = versionSchema.parse(input.expectedVersion);
  await getBookingDraft(context, draftId);
  return db.transaction(async (tx) => {
    await lock(tx, context);
    const draft = await currentDraft(tx, context, draftId, version, now);
    if (draft.status !== "AVAILABILITY_CHECKED" || !draft.currentSearchId) {
      throw new AppError("BOOKING_OFFER_STALE", "Please check this appointment again.", 409);
    }
    const [offer] = await tx.select().from(bookingOffers).where(and(
      eq(bookingOffers.id, offerId), eq(bookingOffers.workspaceId, context.workspaceId),
      eq(bookingOffers.draftId, draftId), eq(bookingOffers.draftVersion, version),
      eq(bookingOffers.searchId, draft.currentSearchId),
    )).limit(1);
    if (!offer || offer.expiresAt <= now) {
      throw new AppError("BOOKING_OFFER_STALE", "This available time has expired; please check again.", 409);
    }
    const [updated] = await tx.update(bookingDrafts).set({
      selectedOfferId: offerId, currentPreviewId: null,
      version: version + 1, status: "AVAILABILITY_CHECKED", updatedAt: now,
    }).where(and(owned(context, draftId), eq(bookingDrafts.version, version))).returning();
    if (!updated) throw new AppError("BOOKING_STALE_VERSION", "The booking has changed.", 409);
    return { state: "SELECTED" as const, offer, draft: updated };
  });
}

export async function prepareBookingPreview(
  context: BookingContext,
  input: { draftId: string; expectedVersion: number },
  now = new Date(),
) {
  const draftId = idSchema.parse(input.draftId), version = versionSchema.parse(input.expectedVersion);
  await getBookingDraft(context, draftId);
  return db.transaction(async (tx) => {
    await lock(tx, context);
    const draft = await currentDraft(tx, context, draftId, version, now);
    if (draft.status !== "AVAILABILITY_CHECKED" || !draft.selectedOfferId) {
      throw new AppError("BOOKING_OFFER_REQUIRED", "Select an available time before confirming.", 409);
    }
    const [offer] = await tx.select().from(bookingOffers).where(and(
      eq(bookingOffers.id, draft.selectedOfferId),
      eq(bookingOffers.workspaceId, context.workspaceId), eq(bookingOffers.draftId, draftId),
    )).limit(1);
    if (!offer || offer.expiresAt <= now) {
      throw new AppError("BOOKING_OFFER_STALE", "This available time has expired; please check again.", 409);
    }
    const service = await requireBookingService(context.workspaceId, offer.serviceId);
    const activeBinding = await currentBookingBinding(context.workspaceId, service);
    if (activeBinding.fingerprint !== offer.bindingFingerprint) {
      throw new AppError("BOOKING_BINDING_CHANGED", "Booking settings have changed. Check availability again.", 409);
    }
    const content = {
      serviceId: offer.serviceId, serviceName: service.name,
      durationMinutes: offer.durationMinutes, requiredLocation: draft.requiredLocation,
      startsAt: offer.startsAt.toISOString(), endsAt: offer.endsAt.toISOString(),
      timezone: offer.timezone,
      displayStart: displayBookingInstant(offer.startsAt, offer.timezone),
      displayEnd: displayBookingInstant(offer.endsAt, offer.timezone),
    };
    const [preview] = await tx.insert(bookingPreviews).values({
      workspaceId: context.workspaceId, draftId, draftVersion: version,
      offerId: offer.id, content, expiresAt: offer.expiresAt,
    }).returning();
    const [updated] = await tx.update(bookingDrafts).set({
      status: "AWAITING_CONFIRMATION", currentPreviewId: preview.id, updatedAt: now,
    }).where(and(owned(context, draftId), eq(bookingDrafts.version, version))).returning();
    if (!updated) throw new AppError("BOOKING_STALE_VERSION", "The booking has changed.", 409);
    return { state: "PREVIEW_READY" as const, preview, draft: updated };
  });
}

export async function recordBookingPreviewDelivery(
  context: BookingContext,
  input: {
    draftId: string; expectedVersion: number; previewId: string;
    deliveryChannel: "WEBCHAT" | "PHONE" | "SMS" | "WHATSAPP";
    deliveryReference: string;
  },
  now = new Date(),
) {
  const draftId = idSchema.parse(input.draftId), previewId = idSchema.parse(input.previewId);
  const version = versionSchema.parse(input.expectedVersion);
  const reference = z.string().min(1).max(300).parse(input.deliveryReference);
  await getBookingDraft(context, draftId);
  return db.transaction(async (tx) => {
    await lock(tx, context);
    const draft = await currentDraft(tx, context, draftId, version, now);
    if (draft.currentPreviewId !== previewId || draft.status !== "AWAITING_CONFIRMATION") {
      throw new AppError("BOOKING_PREVIEW_STALE", "This preview no longer matches the booking.", 409);
    }
    const [preview] = await tx.select().from(bookingPreviews).where(and(
      eq(bookingPreviews.id, previewId), eq(bookingPreviews.workspaceId, context.workspaceId),
      eq(bookingPreviews.draftId, draftId), eq(bookingPreviews.draftVersion, version),
    )).limit(1);
    if (!preview || preview.expiresAt <= now) {
      throw new AppError("BOOKING_PREVIEW_STALE", "This booking preview has expired.", 409);
    }
    if (input.deliveryChannel !== context.channel) {
      throw new AppError("BOOKING_CHANNEL_MISMATCH", "Confirmation must use the originating booking channel.", 409);
    }
    if (context.channel === "WEBCHAT") {
      const [outbound] = await tx.select().from(messages).where(and(
        eq(messages.id, reference), eq(messages.workspaceId, context.workspaceId),
        eq(messages.conversationId, context.conversationId!),
        eq(messages.channel, "WEBCHAT"), eq(messages.direction, "OUTBOUND"),
        eq(messages.senderType, "AI"),
      )).limit(1);
      if (!outbound || outbound.metadata.bookingPreviewId !== previewId ||
        outbound.metadata.bookingDraftId !== draftId ||
        outbound.metadata.bookingVersion !== version) {
        throw new AppError("BOOKING_DELIVERY_NOT_VERIFIED",
          "The current appointment preview was not delivered in this conversation.", 409);
      }
    }
    if (preview.deliveredAt) {
      if (preview.deliveryChannel !== input.deliveryChannel ||
        preview.deliveryReference !== reference) {
        throw new AppError("BOOKING_DELIVERY_CONFLICT", "This preview was already delivered in another response.", 409);
      }
      return preview;
    }
    const [delivered] = await tx.update(bookingPreviews).set({
      deliveryChannel: input.deliveryChannel, deliveryReference: reference, deliveredAt: now,
    }).where(and(eq(bookingPreviews.id, previewId),
      eq(bookingPreviews.workspaceId, context.workspaceId))).returning();
    return delivered;
  });
}

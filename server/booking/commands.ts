import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  aiAgents, appointments, bookingCommands, bookingDrafts,
  bookingOffers, bookingPreviews, bookingReservations, bookingSourceEvents,
  contacts, conversations, messages,
} from "@/db/schema";
import { capabilitiesFromBehaviorSettings, assertAgentActionAllowed } from "@/server/agent/capabilities";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { assertNativePolicyAvailability } from "@/server/domain/core/repository";
import { validateNativeBooking } from "@/server/domain/core/native-calendar";
import { AppError } from "@/server/http/errors";
import { isExplicitActionConfirmation } from "@/server/orchestrator/pending-actions";
import { getBookingDraft, type BookingContext } from "./drafts";
import { currentBookingBinding, requireBookingService } from "./offers";

const idSchema = z.string().uuid();
const versionSchema = z.number().int().positive();
const ACTIVE_STATES = ["PENDING", "COMMITTING", "RECONCILING", "CONFIRMED", "FAILED"] as const;

function owned(context: BookingContext, id: string) {
  return and(eq(bookingDrafts.id, id), eq(bookingDrafts.workspaceId, context.workspaceId),
    eq(bookingDrafts.contactId, context.contactId), eq(bookingDrafts.sessionKey, context.sessionKey),
    eq(bookingDrafts.channel, context.channel));
}

async function assertAgentPermission(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0], context: BookingContext,
) {
  const [agent] = await tx.select().from(aiAgents).where(eq(aiAgents.workspaceId, context.workspaceId)).limit(1);
  if (!agent || agent.status !== "ACTIVE") {
    throw new AppError("AGENT_NOT_ACTIVE", "The AI agent is not active for bookings.", 409);
  }
  assertAgentActionAllowed(capabilitiesFromBehaviorSettings(agent.behaviorSettings), "BOOK_APPOINTMENT");
  if (context.conversationId) {
    const [conversation] = await tx.select().from(conversations).where(and(
      eq(conversations.id, context.conversationId), eq(conversations.workspaceId, context.workspaceId),
      eq(conversations.contactId, context.contactId),
    )).limit(1);
    if (!conversation || conversation.handlingMode === "HUMAN") {
      throw new AppError("BOOKING_HUMAN_HANDLING", "This conversation is currently handled by staff.", 409);
    }
  }
}

async function assertCustomerConfirmation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  context: BookingContext, sourceEventId: string, deliveredAt: Date,
) {
  if (!context.conversationId) {
    throw new AppError("BOOKING_CONFIRMATION_EVIDENCE_REQUIRED", "Confirmation needs a current customer message.", 409);
  }
  const [latest] = await tx.select().from(messages).where(and(
    eq(messages.workspaceId, context.workspaceId),
    eq(messages.conversationId, context.conversationId),
    eq(messages.channel, context.channel), eq(messages.senderType, "CUSTOMER"),
    inArray(messages.contentType, ["TEXT", "CALL_TRANSCRIPT"]),
  )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  if (!latest || latest.id !== sourceEventId || latest.createdAt < deliveredAt ||
    !isExplicitActionConfirmation(latest.body)) {
    throw new AppError("BOOKING_CONFIRMATION_REQUIRED",
      "Please explicitly confirm the current appointment preview.", 409);
  }
  if (context.channel === "PHONE" && latest.metadata.voiceCallId !== context.sessionKey) {
    throw new AppError("BOOKING_CONFIRMATION_SESSION_MISMATCH", "This confirmation belongs to another call.", 409);
  }
}

export async function confirmBookingPreview(
  context: BookingContext,
  input: { draftId: string; expectedVersion: number; previewId: string; sourceEventId: string },
  now = new Date(),
) {
  const draftId = idSchema.parse(input.draftId), previewId = idSchema.parse(input.previewId);
  const version = versionSchema.parse(input.expectedVersion);
  const sourceEventId = idSchema.parse(input.sourceEventId);
  const priorDraft = await getBookingDraft(context, draftId);
  if (priorDraft.bookingCommandId) {
    const [priorCommand] = await db.select().from(bookingCommands).where(and(
      eq(bookingCommands.id, priorDraft.bookingCommandId),
      eq(bookingCommands.workspaceId, context.workspaceId),
      eq(bookingCommands.draftId, draftId),
      eq(bookingCommands.previewId, previewId),
    )).limit(1);
    if (priorCommand) return { state: priorCommand.state, command: priorCommand };
    throw new AppError("BOOKING_PREVIEW_STALE", "This preview is no longer available.", 409);
  }
  const [preview] = await db.select().from(bookingPreviews).where(and(
    eq(bookingPreviews.id, previewId), eq(bookingPreviews.workspaceId, context.workspaceId),
    eq(bookingPreviews.draftId, draftId), eq(bookingPreviews.draftVersion, version),
  )).limit(1);
  if (!preview || !preview.deliveredAt || preview.expiresAt <= now) {
    throw new AppError("BOOKING_PREVIEW_STALE", "This appointment preview is no longer valid.", 409);
  }
  const [offer] = await db.select().from(bookingOffers).where(and(
    eq(bookingOffers.id, preview.offerId), eq(bookingOffers.workspaceId, context.workspaceId),
    eq(bookingOffers.draftId, draftId),
  )).limit(1);
  if (!offer || offer.expiresAt <= now) {
    throw new AppError("BOOKING_OFFER_STALE", "This appointment time has expired. Please check again.", 409);
  }
  // Resolve these outside the short capacity transaction. Every important
  // version, capability, policy and local conflict is checked again inside.
  const service = await requireBookingService(context.workspaceId, offer.serviceId);
  const binding = await currentBookingBinding(context.workspaceId, service);
  if (binding.fingerprint !== offer.bindingFingerprint ||
    binding.integrationId !== offer.integrationId) {
    throw new AppError("BOOKING_BINDING_CHANGED", "Booking settings changed. Please check availability again.", 409);
  }
  const policy = await validateNativeBooking(context.workspaceId, offer);
  const checked = await calendarBookingService.getAvailability(context.workspaceId, {
    startsAt: offer.startsAt, endsAt: offer.endsAt,
    timezone: offer.timezone, durationMinutes: offer.durationMinutes,
  });
  if (!checked.slots.some((slot) => slot.startsAt.getTime() === offer.startsAt.getTime() &&
    slot.endsAt.getTime() === offer.endsAt.getTime())) {
    // A duplicate confirmation can race the original command's reservation or
    // confirmed appointment. Resolve the original result before reporting the
    // original customer's own time as unavailable.
    const refreshed = await getBookingDraft(context, draftId);
    if (refreshed.bookingCommandId) {
      const [existing] = await db.select().from(bookingCommands).where(and(
        eq(bookingCommands.id, refreshed.bookingCommandId),
        eq(bookingCommands.workspaceId, context.workspaceId),
        eq(bookingCommands.draftId, draftId),
        eq(bookingCommands.previewId, previewId),
      )).limit(1);
      if (existing) return { state: existing.state, command: existing };
    }
    throw new AppError("APPOINTMENT_SLOT_UNAVAILABLE", "This time is no longer available.", 409);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${context.workspaceId + ":" + context.sessionKey}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${context.workspaceId}))`);
    const [draft] = await tx.select().from(bookingDrafts).where(owned(context, draftId)).limit(1);
    if (!draft) throw new AppError("BOOKING_NOT_FOUND", "Booking session not found.", 404);
    if (draft.bookingCommandId) {
      const [existing] = await tx.select().from(bookingCommands).where(and(
        eq(bookingCommands.id, draft.bookingCommandId),
        eq(bookingCommands.workspaceId, context.workspaceId),
        eq(bookingCommands.previewId, previewId),
      )).limit(1);
      if (existing && ACTIVE_STATES.includes(existing.state as typeof ACTIVE_STATES[number])) {
        return { state: existing.state, command: existing };
      }
      throw new AppError("BOOKING_PREVIEW_STALE", "This booking has already been handled.", 409);
    }
    if (draft.status !== "AWAITING_CONFIRMATION" || draft.version !== version ||
      draft.currentPreviewId !== previewId || draft.selectedOfferId !== offer.id ||
      draft.expiresAt <= now) {
      throw new AppError("BOOKING_PREVIEW_STALE", "The appointment details have changed.", 409);
    }
    await assertAgentPermission(tx, context);
    await assertCustomerConfirmation(tx, context, sourceEventId, preview.deliveredAt!);
    const [existingEvent] = await tx.select().from(bookingSourceEvents).where(and(
      eq(bookingSourceEvents.workspaceId, context.workspaceId),
      eq(bookingSourceEvents.sessionKey, context.sessionKey),
      eq(bookingSourceEvents.sourceEventId, sourceEventId),
    )).limit(1);
    if (existingEvent) throw new AppError("BOOKING_SOURCE_EVENT_CONFLICT",
      "This customer message was already used for another booking operation.", 409);
    const [customer] = await tx.select().from(contacts).where(and(
      eq(contacts.workspaceId, context.workspaceId), eq(contacts.id, context.contactId),
    )).limit(1);
    if (!customer) throw new AppError("BOOKING_NOT_FOUND", "Booking session not found.", 404);
    if (["calcom", "calendly"].includes(binding.provider) && !customer.email) {
      throw new AppError("BOOKING_ATTENDEE_EMAIL_REQUIRED",
        "An email address is required to book using this calendar provider.", 422);
    }
    const [appointmentsInRange, reserved] = await Promise.all([
      tx.select().from(appointments).where(and(
        eq(appointments.workspaceId, context.workspaceId),
        inArray(appointments.status, ["PENDING", "CONFIRMED"]),
        lt(appointments.startsAt, new Date(offer.endsAt.getTime() + 36 * 60 * 60_000)),
        gt(appointments.endsAt, new Date(offer.startsAt.getTime() - 36 * 60 * 60_000)),
      )).limit(1001),
      tx.select().from(bookingReservations).where(and(
        eq(bookingReservations.workspaceId, context.workspaceId),
        eq(bookingReservations.state, "ACTIVE"),
        lt(bookingReservations.startsAt, new Date(offer.endsAt.getTime() + 36 * 60 * 60_000)),
        gt(bookingReservations.endsAt, new Date(offer.startsAt.getTime() - 36 * 60 * 60_000)),
      )).limit(1001),
    ]);
    if (appointmentsInRange.length > 1000 || reserved.length > 1000) {
      throw new AppError("AVAILABILITY_INCOMPLETE", "Unable to verify the booking capacity safely.", 503);
    }
    assertNativePolicyAvailability(offer, [...appointmentsInRange, ...reserved], policy);
    const commandId = randomUUID();
    const providerEventKey = binding.provider === "google"
      ? "aicaller" + commandId.replaceAll("-", "")
      : binding.provider === "outlook" ? commandId : null;
    const snapshot = {
      serviceId: service.id, title: service.name, durationMinutes: offer.durationMinutes,
      startsAt: offer.startsAt.toISOString(), endsAt: offer.endsAt.toISOString(),
      timezone: offer.timezone, location: draft.requiredLocation,
      contactId: context.contactId, conversationId: context.conversationId,
      attendeeName: customer.name, attendeeEmail: customer.email,
      bindingFingerprint: offer.bindingFingerprint,
    };
    const [command] = await tx.insert(bookingCommands).values({
      id: commandId, workspaceId: context.workspaceId, draftId, draftVersion: version,
      previewId, offerId: offer.id, state: "PENDING",
      snapshot, provider: offer.provider, integrationId: offer.integrationId,
      providerEventKey,
    }).returning();
    await tx.insert(bookingReservations).values({
      workspaceId: context.workspaceId, commandId,
      resourceKey: "workspace", startsAt: offer.startsAt,
      endsAt: offer.endsAt, timezone: policy.timezone, state: "ACTIVE",
    });
    await tx.update(bookingDrafts).set({
      status: "COMMITTING", bookingCommandId: commandId, updatedAt: now,
    }).where(and(owned(context, draftId), eq(bookingDrafts.version, version)));
    await tx.insert(bookingSourceEvents).values({
      workspaceId: context.workspaceId, sessionKey: context.sessionKey,
      draftId, sourceEventId, operation: "CONFIRM", resultVersion: version,
    });
    return { state: "PENDING" as const, command };
  });
}

export async function getBookingOutcome(context: BookingContext, draftId: string) {
  const draft = await getBookingDraft(context, idSchema.parse(draftId));
  if (!draft.bookingCommandId) return { state: draft.status, appointment: null };
  const [command] = await db.select().from(bookingCommands).where(and(
    eq(bookingCommands.id, draft.bookingCommandId),
    eq(bookingCommands.workspaceId, context.workspaceId),
    eq(bookingCommands.draftId, draft.id),
  )).limit(1);
  if (!command) throw new AppError("BOOKING_RECEIPT_UNAVAILABLE", "Booking outcome is temporarily unavailable.", 503);
  const [appointment] = command.appointmentId ? await db.select().from(appointments).where(and(
    eq(appointments.id, command.appointmentId),
    eq(appointments.workspaceId, context.workspaceId),
    eq(appointments.bookingCommandId, command.id),
  )).limit(1) : [];
  return { state: command.state, appointment: appointment ?? null, commandId: command.id };
}

export async function confirmAndExecuteBooking(
  context: BookingContext,
  input: Parameters<typeof confirmBookingPreview>[1],
  now = new Date(),
) {
  const accepted = await confirmBookingPreview(context, input, now);
  const { executeBookingCommand } = await import("./execution");
  return executeBookingCommand(context.workspaceId, accepted.command.id);
}

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bookingDrafts, bookingSourceEvents, contacts, conversations, services } from "@/db/schema";
import { AppError } from "@/server/http/errors";

// Internal boundary only: channel adapters must derive this identity from their authenticated
// session / call / webhook. Never accept workspace, contact or sessionKey from model output.
const contextSchema = z.object({
  workspaceId: z.string().uuid(),
  contactId: z.string().uuid(),
  conversationId: z.string().uuid().nullable(),
  sessionKey: z.string().min(1).max(300),
  channel: z.enum(["PHONE", "SMS", "WHATSAPP", "WEBCHAT"]),
}).strict();

const timezone = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Invalid timezone");

const patchSchema = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  customerTimezone: timezone.nullable().optional(),
  requiredLocation: z.string().trim().min(1).max(2000).nullable().optional(),
  originalDateExpression: z.string().trim().min(1).max(500).nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Empty booking patch");

const eventIdSchema = z.string().min(1).max(300);
const editable = ["COLLECTING", "AVAILABILITY_CHECKED", "AWAITING_CONFIRMATION"] as const;
const active = [...editable, "COMMITTING", "RECONCILING"] as const;

export type BookingContext = z.infer<typeof contextSchema>;
export type BookingPatch = z.infer<typeof patchSchema>;
export type BookingDraft = typeof bookingDrafts.$inferSelect;
type DraftOutcome =
  | { state: "OPENED" | "EXISTING" | "UPDATED" | "UNCHANGED" | "CANCELLED"; draft: BookingDraft }
  | { state: "REPLAY"; version: number };

// Advisory lock serializes all changes for the *authenticated booking session*, not the
// contact or conversation. Two different calls from the same contact never share a draft.
async function lockSession(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], context: BookingContext) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booking:${context.workspaceId}:${context.sessionKey}`}))`);
}

async function assertOwner(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], context: BookingContext) {
  const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(and(
    eq(contacts.id, context.contactId), eq(contacts.workspaceId, context.workspaceId),
  )).limit(1);
  if (!contact) throw new AppError("BOOKING_NOT_FOUND", "Booking session not found.", 404);
  if (context.conversationId) {
    const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(and(
      eq(conversations.id, context.conversationId),
      eq(conversations.workspaceId, context.workspaceId),
      eq(conversations.contactId, context.contactId),
    )).limit(1);
    if (!conversation) throw new AppError("BOOKING_NOT_FOUND", "Booking session not found.", 404);
  }
}

async function ownedDraft(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  context: BookingContext,
  draftId: string,
) {
  const [draft] = await tx.select().from(bookingDrafts).where(and(
    eq(bookingDrafts.id, draftId),
    eq(bookingDrafts.workspaceId, context.workspaceId),
    eq(bookingDrafts.contactId, context.contactId),
    eq(bookingDrafts.sessionKey, context.sessionKey),
    eq(bookingDrafts.channel, context.channel),
    context.conversationId
      ? eq(bookingDrafts.conversationId, context.conversationId)
      : isNull(bookingDrafts.conversationId),
  )).limit(1);
  if (!draft) throw new AppError("BOOKING_NOT_FOUND", "Booking session not found.", 404);
  return draft;
}

async function recordedEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  context: BookingContext,
  draftId: string,
  sourceEventId: string,
  operation: string,
) {
  const [event] = await tx.select().from(bookingSourceEvents).where(and(
    eq(bookingSourceEvents.workspaceId, context.workspaceId),
    eq(bookingSourceEvents.sessionKey, context.sessionKey),
    eq(bookingSourceEvents.sourceEventId, sourceEventId),
  )).limit(1);
  if (!event) return null;
  if (event.draftId !== draftId || event.operation !== operation) {
    throw new AppError("BOOKING_SOURCE_EVENT_CONFLICT", "This customer event belongs to another booking operation.", 409);
  }
  return { state: "REPLAY" as const, version: event.resultVersion };
}

async function saveEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  context: BookingContext,
  draftId: string,
  sourceEventId: string,
  operation: string,
  resultVersion: number,
) {
  await tx.insert(bookingSourceEvents).values({
    workspaceId: context.workspaceId,
    sessionKey: context.sessionKey,
    draftId,
    sourceEventId,
    operation,
    resultVersion,
  });
}

export async function openBookingDraft(rawContext: BookingContext, now = new Date()): Promise<DraftOutcome> {
  const context = contextSchema.parse(rawContext);
  if (!Number.isFinite(now.getTime())) throw new AppError("BOOKING_INVALID_CLOCK", "Invalid booking clock.");
  return db.transaction(async (tx) => {
    await lockSession(tx, context);
    await assertOwner(tx, context);
    const [existing] = await tx.select().from(bookingDrafts).where(and(
      eq(bookingDrafts.workspaceId, context.workspaceId),
      eq(bookingDrafts.sessionKey, context.sessionKey),
      inArray(bookingDrafts.status, [...active]),
    )).orderBy(desc(bookingDrafts.updatedAt)).limit(1);

    if (existing) {
      // A collision or tampered session identifier must never reveal another customer.
      await ownedDraft(tx, context, existing.id);
      if (editable.some((state) => state === existing.status) && existing.expiresAt <= now) {
        await tx.update(bookingDrafts).set({
          status: "EXPIRED",
          updatedAt: now,
        }).where(and(eq(bookingDrafts.id, existing.id), eq(bookingDrafts.version, existing.version)));
      } else {
        return { state: "EXISTING", draft: existing };
      }
    }
    const [draft] = await tx.insert(bookingDrafts).values({
      workspaceId: context.workspaceId,
      contactId: context.contactId,
      conversationId: context.conversationId,
      channel: context.channel,
      sessionKey: context.sessionKey,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    }).returning();
    return { state: "OPENED", draft };
  });
}

export async function getBookingDraft(rawContext: BookingContext, draftId: string): Promise<BookingDraft> {
  const context = contextSchema.parse(rawContext);
  const id = z.string().uuid().parse(draftId);
  return db.transaction((tx) => ownedDraft(tx, context, id));
}

export async function patchBookingDraft(
  rawContext: BookingContext,
  input: { draftId: string; expectedVersion: number; patch: BookingPatch; sourceEventId: string },
  now = new Date(),
): Promise<DraftOutcome> {
  const context = contextSchema.parse(rawContext);
  const id = z.string().uuid().parse(input.draftId);
  const version = z.number().int().positive().parse(input.expectedVersion);
  const patch = patchSchema.parse(input.patch);
  const sourceEventId = eventIdSchema.parse(input.sourceEventId);
  return db.transaction(async (tx) => {
    await lockSession(tx, context);
    const draft = await ownedDraft(tx, context, id);
    const replay = await recordedEvent(tx, context, id, sourceEventId, "PATCH");
    if (replay) return replay;
    if (!editable.some((state) => state === draft.status) || draft.expiresAt <= now) {
      throw new AppError("BOOKING_DRAFT_NOT_EDITABLE", "This booking draft can no longer be edited.", 409);
    }
    if (draft.version !== version) {
      throw new AppError("BOOKING_STALE_VERSION", "The appointment details have changed; reload the current draft.", 409);
    }
    if (patch.serviceId) {
      const [service] = await tx.select({ id: services.id }).from(services).where(and(
        eq(services.id, patch.serviceId), eq(services.workspaceId, context.workspaceId),
      )).limit(1);
      if (!service) throw new AppError("BOOKING_SERVICE_NOT_FOUND", "Service not found.", 404);
    }
    const changed = Object.entries(patch).some(([key, value]) => draft[key as keyof BookingPatch] !== value);
    if (!changed) {
      await saveEvent(tx, context, id, sourceEventId, "PATCH", draft.version);
      return { state: "UNCHANGED", draft };
    }
    const [updated] = await tx.update(bookingDrafts).set({
      ...patch,
      status: "COLLECTING",
      version: draft.version + 1,
      updatedAt: now,
    }).where(and(
      eq(bookingDrafts.id, id),
      eq(bookingDrafts.workspaceId, context.workspaceId),
      eq(bookingDrafts.version, version),
      inArray(bookingDrafts.status, [...editable]),
    )).returning();
    if (!updated) throw new AppError("BOOKING_STALE_VERSION", "The appointment details have changed; reload the current draft.", 409);
    await saveEvent(tx, context, id, sourceEventId, "PATCH", updated.version);
    return { state: "UPDATED", draft: updated };
  });
}

export async function cancelBookingDraft(
  rawContext: BookingContext,
  input: { draftId: string; expectedVersion: number; sourceEventId: string },
  now = new Date(),
): Promise<DraftOutcome> {
  const context = contextSchema.parse(rawContext);
  const id = z.string().uuid().parse(input.draftId);
  const version = z.number().int().positive().parse(input.expectedVersion);
  const sourceEventId = eventIdSchema.parse(input.sourceEventId);
  return db.transaction(async (tx) => {
    await lockSession(tx, context);
    const draft = await ownedDraft(tx, context, id);
    const replay = await recordedEvent(tx, context, id, sourceEventId, "CANCEL");
    if (replay) return replay;
    if (draft.version !== version) throw new AppError("BOOKING_STALE_VERSION", "The appointment details have changed; reload the current draft.", 409);
    if (!editable.some((state) => state === draft.status)) {
      throw new AppError("BOOKING_DRAFT_NOT_EDITABLE", "The booking is no longer an uncommitted draft.", 409);
    }
    const [cancelled] = await tx.update(bookingDrafts).set({
      status: "CANCELLED",
      version: version + 1,
      updatedAt: now,
    }).where(and(eq(bookingDrafts.id, id), eq(bookingDrafts.version, version))).returning();
    if (!cancelled) throw new AppError("BOOKING_STALE_VERSION", "The appointment details have changed; reload the current draft.", 409);
    await saveEvent(tx, context, id, sourceEventId, "CANCEL", cancelled.version);
    return { state: "CANCELLED", draft: cancelled };
  });
}

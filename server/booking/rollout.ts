import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookingDrafts, pendingAgentActions, webchatSessions, webchatTurns, workspaceEntitlements } from "@/db/schema";
import type { BookingContext } from "./drafts";

// Durable booking is the production default. Explicit rollback and the original
// opt-in mode remain available; existing in-flight sessions are not repinned.
export async function isBookingV2Enabled(workspaceId: string) {
  const mode = process.env.AI_CALLER_BOOKING_V2?.trim() || "enabled";
  if (mode !== "enabled" && mode !== "opt-in") return false;
  const [flag] = await db.select({ value: workspaceEntitlements.value })
    .from(workspaceEntitlements).where(and(
      eq(workspaceEntitlements.workspaceId, workspaceId),
      eq(workspaceEntitlements.key, "BOOKING_ENGINE_VERSION"),
    )).limit(1);
  if (flag?.value === "v1") return false;
  return mode === "enabled" || flag?.value === "v2";
}

export function isFreshBookingRequest(message: string) {
  // "Book it"/"yes" must finish their original preview, never switch engines.
  return /\b(?:book|schedule|reserve)\s+(?:an?|another|new)\b/i.test(message);
}

export async function upgradeWebchatBookingSession(
  session: typeof webchatSessions.$inferSelect, message: string, turnId: string,
) {
  if (session.bookingEngineVersion === "v2" || !isFreshBookingRequest(message) ||
    !await isBookingV2Enabled(session.workspaceId)) return session;
  return db.transaction(async tx => {
    // Use the legacy commit gate's lock so an already-authorized command cannot
    // be moved to the new engine while its side effect is unresolved.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${session.workspaceId + ":" + session.conversationId}))`);
    const [pending] = await tx.select({ id: pendingAgentActions.id }).from(pendingAgentActions).where(and(
      eq(pendingAgentActions.workspaceId, session.workspaceId),
      eq(pendingAgentActions.conversationId, session.conversationId),
      eq(pendingAgentActions.type, "BOOK_APPOINTMENT"),
      eq(pendingAgentActions.status, "CONFIRMED"),
    )).limit(1);
    const [processing] = await tx.select({ id: webchatTurns.id }).from(webchatTurns).where(and(
      eq(webchatTurns.sessionId, session.id), eq(webchatTurns.status, "PROCESSING"),
      ne(webchatTurns.id, turnId),
    )).limit(1);
    if (pending || processing) return session;
    await tx.update(pendingAgentActions).set({ status: "SUPERSEDED", updatedAt: new Date() }).where(and(
      eq(pendingAgentActions.workspaceId, session.workspaceId),
      eq(pendingAgentActions.conversationId, session.conversationId),
      eq(pendingAgentActions.type, "BOOK_APPOINTMENT"),
      eq(pendingAgentActions.status, "AWAITING_CONFIRMATION"),
    ));
    const [updated] = await tx.update(webchatSessions).set({ bookingEngineVersion: "v2" }).where(and(
      eq(webchatSessions.id, session.id), eq(webchatSessions.workspaceId, session.workspaceId),
    )).returning();
    return updated ?? session;
  });
}

export async function shouldUseBookingV2(context: BookingContext) {
  const [active] = await db.select({ id: bookingDrafts.id }).from(bookingDrafts).where(and(
    eq(bookingDrafts.workspaceId, context.workspaceId),
    eq(bookingDrafts.contactId, context.contactId),
    eq(bookingDrafts.sessionKey, context.sessionKey),
    eq(bookingDrafts.channel, context.channel),
    inArray(bookingDrafts.status, [
      "COLLECTING", "AVAILABILITY_CHECKED", "AWAITING_CONFIRMATION",
      "COMMITTING", "RECONCILING",
    ]),
  )).limit(1);
  return Boolean(active) || isBookingV2Enabled(context.workspaceId);
}

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bookingDrafts, workspaceEntitlements } from "@/db/schema";
import type { BookingContext } from "./drafts";

// Explicit per-workspace, new-session opt-in. Never activate an incomplete engine
// by applying a migration or redeploying web/worker/gateway.
export async function isBookingV2Enabled(workspaceId: string) {
  if (process.env.AI_CALLER_BOOKING_V2 !== "enabled") return false;
  const [flag] = await db.select({ value: workspaceEntitlements.value })
    .from(workspaceEntitlements).where(and(
      eq(workspaceEntitlements.workspaceId, workspaceId),
      eq(workspaceEntitlements.key, "BOOKING_ENGINE_VERSION"),
    )).limit(1);
  return flag?.value === "v2";
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

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceEntitlements } from "@/db/schema";

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

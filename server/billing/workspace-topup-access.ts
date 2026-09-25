import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceCommercialOwners } from "@/db/schema";
import { AppError } from "@/server/http/errors";

/** Operational OWNER access never confers rights to buy credits for an Agency client. */
export async function canPurchaseWorkspaceCredits(userId: string, workspaceId: string) {
  const [commercial] = await db.select({ purchaserUserId: workspaceCommercialOwners.purchaserUserId })
    .from(workspaceCommercialOwners)
    .where(eq(workspaceCommercialOwners.workspaceId, workspaceId))
    .limit(1);
  // Legacy workspaces without a reconciled purchaser keep existing OWNER permission checks.
  return !commercial || commercial.purchaserUserId === userId;
}

export async function requireWorkspaceCreditPurchaser(userId: string, workspaceId: string) {
  if (!(await canPurchaseWorkspaceCredits(userId, workspaceId))) {
    throw new AppError(
      "AGENCY_CLIENT_TOPUP_DISABLED",
      "Credits for this client workspace are supplied by its Agency. Contact your Agency to add credits.",
      403,
    );
  }
}

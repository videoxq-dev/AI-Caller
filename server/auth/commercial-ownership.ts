import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships, workspaceCommercialOwners } from "@/db/schema";
import { getWorkspacePlan } from "@/server/billing/plans";
import { wasProvisionedForAgency } from "@/server/commerce/agency-client-classification";
import { AppError } from "@/server/http/errors";
import { getMembership } from "./workspace-repository";

/** An operational OWNER is not necessarily the purchaser of this workspace. */
export async function getCommercialWorkspaceOwner(workspaceId: string) {
  const [owner] = await db.select({
    purchaserUserId: workspaceCommercialOwners.purchaserUserId,
    kind: workspaceCommercialOwners.kind,
    createdAt: workspaceCommercialOwners.createdAt,
  }).from(workspaceCommercialOwners)
    .where(eq(workspaceCommercialOwners.workspaceId, workspaceId))
    .limit(1);
  return owner ?? null;
}

/**
 * Purchaser-side Whitelabel administration never derives authority from the
 * currently selected business or from a delegated client OWNER membership.
 * All three active receipts must belong to this purchaser's original business.
 */
export async function requireEffectiveWhitelabelPurchaser(purchaserUserId: string) {
  const primaries = await db.select({ workspaceId: workspaceCommercialOwners.workspaceId })
    .from(workspaceCommercialOwners)
    .innerJoin(memberships, and(
      eq(memberships.workspaceId, workspaceCommercialOwners.workspaceId),
      eq(memberships.userId, purchaserUserId),
      eq(memberships.role, "OWNER"),
    ))
    .where(and(
      eq(workspaceCommercialOwners.purchaserUserId, purchaserUserId),
      eq(workspaceCommercialOwners.kind, "PRIMARY"),
    ))
    .limit(2);
  if (primaries.length !== 1) {
    throw new AppError("WHITELABEL_REQUIRED", "An active Agency and Whitelabel purchase is required.", 403);
  }
  const [primary] = primaries;
  const rows = await db.select({ code: licenses.productCode }).from(licenses)
    .where(and(
      eq(licenses.workspaceId, primary.workspaceId),
      eq(licenses.purchaserUserId, purchaserUserId),
      eq(licenses.status, "ACTIVE"),
    ));
  const products = new Set(rows.map(({ code }) => code));
  if (!products.has("CORE")
    || !products.has("WHITELABEL")
    || (!products.has("AGENCY_50") && !products.has("AGENCY_100"))) {
    throw new AppError("WHITELABEL_REQUIRED", "An active Agency and Whitelabel purchase is required.", 403);
  }
  return { purchaserUserId, originalWorkspaceId: primary.workspaceId };
}

/**
 * Called only after F12-E resolves and verifies the requesting branded host
 * to its commercial purchaser. Never use an untrusted user-supplied purchaser
 * ID as the hostname identity. Purchasers continue using the canonical app.
 */
export async function requireBrandedClientWorkspaceAccess(
  userId: string,
  workspaceId: string,
  approvedBrandPurchaserUserId: string,
) {
  const commercial = await getCommercialWorkspaceOwner(workspaceId);
  if (!commercial || commercial.kind !== "ADDITIONAL"
    || commercial.purchaserUserId !== approvedBrandPurchaserUserId
    || !(await wasProvisionedForAgency(commercial.purchaserUserId, commercial.createdAt))) {
    throw new AppError("BRANDED_WORKSPACE_NOT_FOUND", "This business is not available on this branded platform.", 404);
  }
  if (userId === approvedBrandPurchaserUserId) {
    throw new AppError("BRANDED_CLIENT_ACCESS_DENIED", "Manage your Agency through AI Caller.", 403);
  }
  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    throw new AppError("BRANDED_WORKSPACE_NOT_FOUND", "This business is not available on this branded platform.", 404);
  }
  await requireEffectiveWhitelabelPurchaser(approvedBrandPurchaserUserId);
  if (membership.workspaceStatus !== "ACTIVE") {
    throw new AppError("WORKSPACE_SUSPENDED", "This workspace is suspended.", 403);
  }
  if (membership.role !== "OWNER") {
    const plan = await getWorkspacePlan(workspaceId);
    if (plan.subUserLimit <= 0) {
      throw new AppError("PLAN_SUBUSER_ACCESS_DISABLED", "This workspace does not include staff access.", 403);
    }
  }
  return membership;
}

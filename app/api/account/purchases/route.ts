import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getOwnedWorkspaceCapacity } from "@/server/auth/workspace-repository";
import { getFunnelAccountSummary } from "@/server/commerce/account-licenses";
import { AppError, toErrorResponse } from "@/server/http/errors";

/**
 * Buyer-level purchase history is independent of the selected workspace.
 * In particular, an owner can still review refunded purchases when their
 * original Core workspace has been suspended.
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const [summary, capacity] = await Promise.all([
      getFunnelAccountSummary(session.user.id),
      getOwnedWorkspaceCapacity(session.user.id),
    ]);
    return Response.json({
      activeProducts: summary.activeProducts,
      effectiveWhitelabel: summary.effectiveWhitelabel,
      licenses: summary.licenses,
      businessLimit: capacity.businessLimit,
      ownedBusinesses: capacity.ownedBusinesses,
      availableBusinesses: capacity.availableBusinesses,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

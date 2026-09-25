import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { getWorkspacePlan } from "@/server/billing/plans";
import { getBillingOverview } from "@/server/billing/checkout";
import { getCreditBalance } from "@/server/credits/service";
import { canPurchaseWorkspaceCredits } from "@/server/billing/workspace-topup-access";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const [plan, balance, overview, canPurchaseCredits] = await Promise.all([
      getWorkspacePlan(context.workspace.id),
      getCreditBalance(context.workspace.id),
      getBillingOverview(context.workspace.id),
      canPurchaseWorkspaceCredits(context.session.user.id, context.workspace.id),
    ]);
    return Response.json({
      workspace: context.workspace,
      plan,
      balance,
      ...overview,
      packs: canPurchaseCredits ? overview.packs : [],
      topups: canPurchaseCredits ? overview.topups : [],
      canPurchaseCredits,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { listAutomationSettings } from "@/server/automations/repository";
import { getWorkspaceIntegrationEntitlements } from "@/server/commerce/workspace-entitlements";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const [settings, entitlement] = await Promise.all([
      listAutomationSettings(context.workspace.id),
      getWorkspaceIntegrationEntitlements(context.workspace.id),
    ]);
    return Response.json({
      settings,
      canManage: context.membership.role === "OWNER" || context.membership.role === "ADMIN",
      canUseAutomationBuilder: entitlement.performanceAutomations,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

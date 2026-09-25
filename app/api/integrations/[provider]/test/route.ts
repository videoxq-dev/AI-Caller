import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireCommercialProviderPurchaser } from "@/server/auth/commercial-ownership";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { bindCapability, getPrivateIntegration, testSavedIntegration } from "@/server/domain/integrations/repository";
import { providerIdSchema } from "@/server/domain/integrations/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { isExternalCalendarProvider, requireProviderIntegrationEntitlement } from "@/server/commerce/workspace-entitlements";

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const { provider: rawProvider } = await params;
    const parsed = providerIdSchema.safeParse(rawProvider);
    if (!parsed.success) throw new AppError("BAD_REQUEST", "Unsupported integration provider.", 400);
    if (parsed.data !== "whatsapp"
      && !isExternalCalendarProvider(parsed.data)) {
      await requireCommercialProviderPurchaser(context.session.user.id, context.workspace.id);
    }
    await requireProviderIntegrationEntitlement(context.workspace.id, parsed.data);

    const integration = await getPrivateIntegration(context.workspace.id, parsed.data);
    if (!integration) throw new AppError("NOT_FOUND", "Integration not found.", 404);

    const result = await testSavedIntegration(context.workspace.id, parsed.data);
    if (result.ok) {
      if (integration.category === "AI" && parsed.data !== "credits") {
        await bindCapability(context.workspace.id, "AI_TEXT", "BYOP", parsed.data);
      }
      if (integration.category === "CALENDAR") {
        await bindCapability(context.workspace.id, "CALENDAR", "BYOP", parsed.data);
      }
      if (integration.category === "WHATSAPP") {
        await bindCapability(context.workspace.id, "WHATSAPP", "BYOP", parsed.data);
      }
    }

    return Response.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

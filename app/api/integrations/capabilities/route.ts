import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getCommercialWorkspaceOwner, requireCommercialProviderPurchaser } from "@/server/auth/commercial-ownership";
import { getWorkspaceIntegrationEntitlements } from "@/server/commerce/workspace-entitlements";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { bindCapability } from "@/server/domain/integrations/repository";
import { capabilityBindingInputSchema } from "@/server/domain/integrations/schemas";
import { resolveProviderRoute } from "@/server/providers/resolver";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { requireCapabilityBindingEntitlement } from "@/server/commerce/workspace-entitlements";

const capabilities = ["AI_TEXT", "SMS", "VOICE", "WHATSAPP", "CALENDAR"] as const;

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const [commercial, entitlement] = await Promise.all([
      getCommercialWorkspaceOwner(context.workspace.id),
      getWorkspaceIntegrationEntitlements(context.workspace.id),
    ]);
    const purchaser = entitlement.purchaserUserId === context.session.user.id
      && (!commercial || commercial.purchaserUserId === context.session.user.id);
    // A client may use the business's WhatsApp/calendar capability, but cannot
    // enumerate the purchaser's AI, voice or SMS provider account/settings.
    const visible = purchaser ? capabilities : (["WHATSAPP", "CALENDAR"] as const);
    const routes = await Promise.all(visible.map(async (capability) =>
      [capability, await resolveProviderRoute(context.workspace.id, capability)] as const));
    return Response.json({
      capabilities: {
        AI_TEXT: null, SMS: null, VOICE: null, WHATSAPP: null, CALENDAR: null,
        ...Object.fromEntries(routes),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(capabilityBindingInputSchema, await request.json());
    // Both directions change the purchaser's provider infrastructure. A
    // delegated client OWNER must not switch the estate to hosted credits.
    if (input.capability === "AI_TEXT" || input.capability === "SMS"
      || input.capability === "VOICE") {
      await requireCommercialProviderPurchaser(context.session.user.id, context.workspace.id);
    }
    await requireCapabilityBindingEntitlement(context.workspace.id, input.capability, input.mode, input.provider ?? null);
    await bindCapability(context.workspace.id, input.capability, input.mode, input.provider ?? null);
    return Response.json({ route: await resolveProviderRoute(context.workspace.id, input.capability) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireCommercialProviderPurchaser } from "@/server/auth/commercial-ownership";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { getCommunicationSetup, saveCommunicationSetup } from "@/server/domain/integrations/repository";
import { communicationSetupSchema } from "@/server/domain/integrations/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { requireCapabilityBindingEntitlement } from "@/server/commerce/workspace-entitlements";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json({ settings: await getCommunicationSetup(context.workspace.id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    // Communication setup writes AI Caller/BYOP voice and SMS bindings; it is
    // purchaser infrastructure administration, not a delegated client setting.
    await requireCommercialProviderPurchaser(context.session.user.id, context.workspace.id);
    const input = parseInput(communicationSetupSchema, await request.json());
    await Promise.all([
      requireCapabilityBindingEntitlement(context.workspace.id, "VOICE", input.voice.mode, input.voice.provider ?? null),
      requireCapabilityBindingEntitlement(context.workspace.id, "SMS", input.sms.mode, input.sms.provider ?? null),
      requireCapabilityBindingEntitlement(context.workspace.id, "WHATSAPP", input.whatsapp.mode, input.whatsapp.provider ?? null),
    ]);
    return Response.json({ settings: await saveCommunicationSetup(context.workspace.id, input) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

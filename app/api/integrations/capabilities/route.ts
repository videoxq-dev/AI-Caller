import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { bindCapability } from "@/server/domain/integrations/repository";
import { capabilityBindingInputSchema } from "@/server/domain/integrations/schemas";
import { resolveProviderRoute } from "@/server/providers/resolver";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const capabilities = ["AI_TEXT", "SMS", "VOICE", "WHATSAPP", "CALENDAR"] as const;

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const routes = await Promise.all(capabilities.map(async (capability) => [capability, await resolveProviderRoute(context.workspace.id, capability)] as const));
    return Response.json({ capabilities: Object.fromEntries(routes) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(capabilityBindingInputSchema, await request.json());
    await bindCapability(context.workspace.id, input.capability, input.mode, input.provider ?? null);
    return Response.json({ route: await resolveProviderRoute(context.workspace.id, input.capability) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

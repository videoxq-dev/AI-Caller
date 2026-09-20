import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { agentCapabilityCatalog, capabilitiesFromBehaviorSettings } from "@/server/agent/capabilities";
import { getAgentSetup, saveAgentSetup } from "@/server/domain/onboarding/repository";
import { aiAgentInputSchema } from "@/server/domain/onboarding/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const setup = await getAgentSetup(context.workspace.id);
    return Response.json({ ...setup, capabilities: setup.agent ? capabilitiesFromBehaviorSettings(setup.agent.behaviorSettings) : null, capabilityCatalog: agentCapabilityCatalog, canManage: context.membership.role !== "STAFF" });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(aiAgentInputSchema, await request.json());
    const agent = await saveAgentSetup(context.workspace.id, input);
    return Response.json({ agent });
  } catch (error) {
    return toErrorResponse(error);
  }
}

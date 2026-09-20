import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { agentCapabilitiesSchema } from "@/server/agent/capabilities";
import { setWorkspaceAgentCapabilities } from "@/server/agent/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const capabilities = parseInput(agentCapabilitiesSchema, await request.json());
    const agent = await setWorkspaceAgentCapabilities(context.workspace.id, capabilities);
    return Response.json({ agent });
  } catch (error) {
    return toErrorResponse(error);
  }
}

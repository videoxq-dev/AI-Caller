import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { setWorkspaceAgentStatus } from "@/server/agent/service";
import { markSetupStep } from "@/server/domain/onboarding/repository";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const statusInputSchema = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]),
}).strict();

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const { status } = parseInput(statusInputSchema, await request.json());
    const agent = await setWorkspaceAgentStatus(context.workspace.id, status);
    if (status === "ACTIVE") await markSetupStep(context.workspace.id, "live");
    return Response.json({ agent });
  } catch (error) {
    return toErrorResponse(error);
  }
}

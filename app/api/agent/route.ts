import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getAgentSetup, saveAgentSetup } from "@/server/domain/onboarding/repository";
import { aiAgentInputSchema } from "@/server/domain/onboarding/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json(await getAgentSetup(context.workspace.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(aiAgentInputSchema, await request.json());
    const agent = await saveAgentSetup(context.workspace.id, input);
    return Response.json({ agent });
  } catch (error) {
    return toErrorResponse(error);
  }
}

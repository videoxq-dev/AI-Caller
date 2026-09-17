import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { createPolicy, getAgentSetup } from "@/server/domain/onboarding/repository";
import { policyInputSchema } from "@/server/domain/onboarding/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const data = await getAgentSetup(context.workspace.id);
    return Response.json({ policies: data.policies });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(policyInputSchema, await request.json());
    return Response.json({ policy: await createPolicy(context.workspace.id, input) }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

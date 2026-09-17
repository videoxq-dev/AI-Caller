import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { createService, getAgentSetup } from "@/server/domain/onboarding/repository";
import { serviceInputSchema } from "@/server/domain/onboarding/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const data = await getAgentSetup(context.workspace.id);
    return Response.json({ services: data.services });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(serviceInputSchema, await request.json());
    return Response.json({ service: await createService(context.workspace.id, input) }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

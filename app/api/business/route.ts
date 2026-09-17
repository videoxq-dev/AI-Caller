import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getBusinessSetup, saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { businessProfileInputSchema } from "@/server/domain/onboarding/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json(await getBusinessSetup(context.workspace.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(businessProfileInputSchema, await request.json());
    const profile = await saveBusinessSetup(context.workspace.id, input);
    return Response.json({ profile });
  } catch (error) {
    return toErrorResponse(error);
  }
}

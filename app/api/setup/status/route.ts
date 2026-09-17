import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getCreditBalance } from "@/server/credits/service";
import { getSetupStatus } from "@/server/domain/onboarding/repository";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const [setup, hostedCredits] = await Promise.all([
      getSetupStatus(context.workspace.id),
      getCreditBalance(context.workspace.id),
    ]);
    return Response.json({ workspace: context.workspace, setup, hostedCredits });
  } catch (error) {
    return toErrorResponse(error);
  }
}

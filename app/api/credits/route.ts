import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getCreditBalance } from "@/server/credits/service";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json({ balance: await getCreditBalance(context.workspace.id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

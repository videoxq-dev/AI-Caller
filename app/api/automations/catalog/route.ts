import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { builderCatalog } from "@/server/automations/builder-catalog";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json({
      catalog: builderCatalog,
      canManage: context.membership.role === "OWNER" || context.membership.role === "ADMIN",
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

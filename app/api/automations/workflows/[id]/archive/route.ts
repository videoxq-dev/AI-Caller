import { parseBuilderWorkflowId } from "@/server/automations/builder-service";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { setWorkflowStatus } from "@/server/automations/workflows";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "automation.manage");
    const id = parseBuilderWorkflowId((await params).id);
    await setWorkflowStatus(context.workspace.id, id, "ARCHIVED");
    return Response.json({ archived: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

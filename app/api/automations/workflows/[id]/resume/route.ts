import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getBuilderWorkflow } from "@/server/automations/builder-service";
import { setWorkflowStatus } from "@/server/automations/workflows";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "automation.manage");
    const { id } = await params;
    await setWorkflowStatus(context.workspace.id, id, "PUBLISHED");
    return Response.json({ workflow: await getBuilderWorkflow(context.workspace.id, id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

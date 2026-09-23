import { z } from "zod";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getBuilderWorkflow } from "@/server/automations/builder-service";
import { updateWorkflowDraft, workflowDefinitionSchema } from "@/server/automations/workflows";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  draft: workflowDefinitionSchema,
}).strict();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const workflow = await getBuilderWorkflow(context.workspace.id, id);
    return Response.json({
      workflow,
      canManage: context.membership.role === "OWNER" || context.membership.role === "ADMIN",
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "automation.manage");
    const { id } = await params;
    const input = parseInput(updateSchema, await request.json());
    await updateWorkflowDraft(context.workspace.id, id, input.name, input.draft);
    const workflow = await getBuilderWorkflow(context.workspace.id, id);
    return Response.json({ workflow });
  } catch (error) {
    return toErrorResponse(error);
  }
}

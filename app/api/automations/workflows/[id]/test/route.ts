import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { testBuilderWorkflow } from "@/server/automations/builder-service";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const result = await testBuilderWorkflow(
      context.workspace.id,
      id,
      await request.json(),
    );
    return Response.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}

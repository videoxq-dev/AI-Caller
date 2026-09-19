import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { deleteKnowledgeSource } from "@/server/knowledge/repository";

export async function DELETE(request: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const { sourceId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new AppError("INVALID_KNOWLEDGE_SOURCE", "Invalid knowledge source.", 400);
    const deleted = await deleteKnowledgeSource(context.workspace.id, sourceId);
    if (!deleted) throw new AppError("KNOWLEDGE_SOURCE_NOT_FOUND", "Knowledge source not found.", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

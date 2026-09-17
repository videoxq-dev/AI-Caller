import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getConversationTimeline } from "@/server/domain/core/repository";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const timeline = await getConversationTimeline(context.workspace.id, id);
    if (!timeline) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
    return Response.json(timeline);
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getConversationTimelinePage } from "@/server/domain/core/conversation-timeline";
import { conversationTimelineQuerySchema } from "@/server/domain/core/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = parseInput(conversationTimelineQuerySchema, query);
    const timeline = await getConversationTimelinePage(context.workspace.id, id, input);
    if (!timeline) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
    return Response.json({ timeline });
  } catch (error) {
    return toErrorResponse(error);
  }
}

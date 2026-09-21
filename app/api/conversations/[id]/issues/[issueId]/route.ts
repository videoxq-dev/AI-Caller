import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { resolveConversationIssue } from "@/server/collaboration/service";
import { toErrorResponse } from "@/server/http/errors";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; issueId: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "conversation.reply");
    const { id, issueId } = await params;
    const issue = await resolveConversationIssue({
      workspaceId: context.workspace.id,
      conversationId: id,
      issueId,
      actorUserId: context.session.user.id,
    });
    return Response.json({ issue });
  } catch (error) {
    return toErrorResponse(error);
  }
}

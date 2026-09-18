import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { hasWorkspacePermission, requireWorkspacePermission } from "@/server/auth/permissions";
import { returnConversationToAI, takeOverConversation } from "@/server/collaboration/service";
import { handlingModeInputSchema } from "@/server/domain/core/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "conversation.takeover");
    const { id } = await params;
    const input = parseInput(handlingModeInputSchema, await request.json());

    if (input.mode === "AI") {
      const conversation = await returnConversationToAI({
        workspaceId: context.workspace.id,
        conversationId: id,
        actorUserId: context.session.user.id,
      });
      return Response.json({ conversation });
    }

    const assignedUserId = input.assignedUserId ?? context.session.user.id;
    if (assignedUserId !== context.session.user.id && !hasWorkspacePermission(context.membership.role, "conversation.assign.any")) {
      throw new AppError("INVALID_ASSIGNEE", "You may only assign a takeover to yourself.", 403);
    }

    const conversation = await takeOverConversation({
      workspaceId: context.workspace.id,
      conversationId: id,
      actorUserId: context.session.user.id,
      assignedUserId,
    });
    return Response.json({ conversation });
  } catch (error) {
    return toErrorResponse(error);
  }
}

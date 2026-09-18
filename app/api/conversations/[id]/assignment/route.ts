import { z } from "zod";
import { hasWorkspacePermission, requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { assignConversation } from "@/server/collaboration/service";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({ assignedUserId: z.string().min(1).nullable() });

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(inputSchema, await request.json());

    if (input.assignedUserId === context.session.user.id) {
      requireWorkspacePermission(context.membership.role, "conversation.assign.self");
    } else {
      if (!hasWorkspacePermission(context.membership.role, "conversation.assign.any")) {
        throw new AppError("FORBIDDEN", "You may only assign conversations to yourself.", 403);
      }
    }

    const conversation = await assignConversation({
      workspaceId: context.workspace.id,
      conversationId: id,
      actorUserId: context.session.user.id,
      assignedUserId: input.assignedUserId,
    });
    return Response.json({ conversation });
  } catch (error) {
    return toErrorResponse(error);
  }
}

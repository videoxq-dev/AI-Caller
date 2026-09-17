import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { setConversationHandlingMode } from "@/server/domain/core/repository";
import { handlingModeInputSchema } from "@/server/domain/core/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(handlingModeInputSchema, await request.json());
    if (input.assignedUserId && input.assignedUserId !== context.session.user.id) {
      throw new AppError("INVALID_ASSIGNEE", "Core currently supports assigning conversations only to the signed-in workspace member.", 403);
    }
    const assignedUserId = input.mode === "HUMAN"
      ? input.assignedUserId ?? context.session.user.id
      : null;
    const conversation = await setConversationHandlingMode(
      context.workspace.id,
      id,
      input.mode,
      assignedUserId,
    );
    return Response.json({ conversation });
  } catch (error) {
    return toErrorResponse(error);
  }
}

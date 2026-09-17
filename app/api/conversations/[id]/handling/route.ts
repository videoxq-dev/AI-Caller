import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { setConversationHandlingMode } from "@/server/domain/core/repository";
import { handlingModeInputSchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(handlingModeInputSchema, await request.json());
    const conversation = await setConversationHandlingMode(
      context.workspace.id,
      id,
      input.mode,
      input.assignedUserId ?? null,
    );
    return Response.json({ conversation });
  } catch (error) {
    return toErrorResponse(error);
  }
}

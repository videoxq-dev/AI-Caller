import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { appendMessage } from "@/server/domain/core/repository";
import { messageInputSchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(messageInputSchema, await request.json());
    const message = await appendMessage(context.workspace.id, id, input);
    return Response.json({ message }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

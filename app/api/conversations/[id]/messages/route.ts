import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { isGuardedE2EFixtureMode } from "@/server/e2e-mode";
import { AppError } from "@/server/http/errors";
import { appendMessage } from "@/server/domain/core/repository";
import { messageInputSchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "conversation.reply");
    const { id } = await params;
    const input = parseInput(messageInputSchema, await request.json());
    // Provider-originated messages must arrive through authenticated webhooks; this
    // general-purpose route cannot forge inbound sender evidence or pretend SMS
    // was delivered without passing the shared campaign/consent send boundary.
    if (!isGuardedE2EFixtureMode() && (
      input.direction !== "INTERNAL" || input.senderType !== "USER" ||
      input.contentType !== "TEXT" || input.provider || input.externalMessageId ||
      input.status || Object.keys(input.metadata).length
    )) {
      throw new AppError("MESSAGE_ORIGIN_NOT_AUTHORIZED",
        "Customer and outbound messages must be created by their verified channel endpoints.", 403);
    }
    const message = await appendMessage(context.workspace.id, id, input);
    return Response.json({ message }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

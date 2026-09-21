import { z } from "zod";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { hasOpenConversationIssue } from "@/server/collaboration/service";
import { getActiveConversationChannel } from "@/server/domain/core/conversation-channels";
import { appendMessage, getConversationById } from "@/server/domain/core/repository";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({ text: z.string().trim().min(1).max(5000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "conversation.reply");
    const { id } = await params;
    const input = parseInput(inputSchema, await request.json());

    const conversation = await getConversationById(context.workspace.id, id);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
    if (conversation.handlingMode !== "HUMAN"
      && !(await hasOpenConversationIssue(context.workspace.id, id))) {
      throw new AppError(
        "STAFF_REPLY_SCOPE_REQUIRED",
        "Take over the conversation or open a staff issue before sending a staff Web Chat reply.",
        409,
      );
    }
    const channel = await getActiveConversationChannel(context.workspace.id, id);
    if (channel !== "WEBCHAT") {
      throw new AppError("WEBCHAT_CONVERSATION_REQUIRED", "This conversation is not an active Web Chat conversation.", 409);
    }

    const message = await appendMessage(context.workspace.id, id, {
      channel: "WEBCHAT",
      direction: "OUTBOUND",
      senderType: "USER",
      contentType: "TEXT",
      body: input.text,
      provider: "webchat-staff",
      externalMessageId: null,
      status: "DELIVERED",
      metadata: { staffUserId: context.session.user.id },
    });
    return Response.json({ message }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

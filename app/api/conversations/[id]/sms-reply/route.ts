import { z } from "zod";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { sendSmsConversationText } from "@/server/sms/outbound";

const inputSchema = z.object({ text: z.string().trim().min(1).max(1600) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "conversation.reply");
    const { id } = await params;
    const input = parseInput(inputSchema, await request.json());
    const message = await sendSmsConversationText(context.workspace.id, id, {
      senderType: "USER",
      text: input.text,
    });
    return Response.json({ message }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

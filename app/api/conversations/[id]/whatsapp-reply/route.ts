import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { sendWhatsAppConversationText } from "@/server/whatsapp/outbound";

const inputSchema = z.object({ text: z.string().trim().min(1).max(4096) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(inputSchema, await request.json());
    const message = await sendWhatsAppConversationText(context.workspace.id, id, {
      senderType: "USER",
      text: input.text,
    });
    return Response.json({ message }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

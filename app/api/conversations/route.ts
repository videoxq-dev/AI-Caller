import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getOrCreateOpenConversation, listConversations } from "@/server/domain/core/repository";
import { conversationListQuerySchema, conversationOpenInputSchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = parseInput(conversationListQuerySchema, query);
    return Response.json(await listConversations(context.workspace.id, input));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(conversationOpenInputSchema, await request.json());
    const conversation = await getOrCreateOpenConversation(context.workspace.id, input.contactId);
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

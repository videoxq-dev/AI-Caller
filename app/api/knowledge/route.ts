import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { listKnowledgeSources } from "@/server/knowledge/repository";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const sources = await listKnowledgeSources(context.workspace.id, 30);
    return Response.json({
      sources: sources.map(({ content: _content, ...source }) => source),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

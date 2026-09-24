import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { getKnowledgeSourceUsage, listKnowledgeSources } from "@/server/knowledge/repository";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const [sources, usage] = await Promise.all([
      listKnowledgeSources(context.workspace.id, 30),
      getKnowledgeSourceUsage(context.workspace.id),
    ]);
    return Response.json({
      sources,
      count: usage.count,
      limit: usage.limit,
      package: usage.package,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

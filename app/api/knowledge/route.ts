import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { getKnowledgeSourceUsage, listKnowledgeSources } from "@/server/knowledge/repository";

const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000),
  limit: z.coerce.number().int().min(1).max(50),
});

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const query = new URL(request.url).searchParams;
    const page = parseInput(pageSchema, {
      offset: query.get("offset") ?? "0",
      limit: query.get("limit") ?? "30",
    });
    const [sources, usage] = await Promise.all([
      listKnowledgeSources(context.workspace.id, page.limit, page.offset),
      getKnowledgeSourceUsage(context.workspace.id),
    ]);
    return Response.json({
      sources,
      total: usage.count,
      limit: usage.limit,
      package: usage.package,
      nextOffset: page.offset + sources.length < usage.count ? page.offset + sources.length : null,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

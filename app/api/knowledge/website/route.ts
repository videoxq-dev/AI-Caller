import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { getKnowledgeSourceUsage, saveKnowledgeSource } from "@/server/knowledge/repository";
import { importWebsiteText } from "@/server/knowledge/website-import";

const schema = z.object({ url: z.string().trim().min(1).max(2000) });

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(schema, await request.json());
    if ((await getKnowledgeSourceUsage(context.workspace.id)).limit === 0) {
      throw new AppError("KNOWLEDGE_IMPORT_REQUIRES_UNLIMITED", "Upgrade to Unlimited to import business knowledge.", 403);
    }
    let imported;
    try {
      imported = await importWebsiteText(input.url);
    } catch (error) {
      throw new AppError(
        "KNOWLEDGE_IMPORT_FAILED",
        error instanceof Error ? error.message : "Unable to import website knowledge.",
        422,
      );
    }
    const source = await saveKnowledgeSource(context.workspace.id, {
      kind: "WEBSITE",
      label: imported.label,
      sourceUrl: imported.sourceUrl,
      content: imported.content,
    });
    return Response.json({ source: { ...source, content: undefined } }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

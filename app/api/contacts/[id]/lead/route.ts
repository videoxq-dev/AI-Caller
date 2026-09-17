import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { upsertLead } from "@/server/domain/core/repository";
import { leadInputSchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(leadInputSchema, await request.json());
    const lead = await upsertLead(context.workspace.id, id, input);
    return Response.json({ lead });
  } catch (error) {
    return toErrorResponse(error);
  }
}

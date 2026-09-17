import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { testSavedIntegration } from "@/server/domain/integrations/repository";
import { providerIdSchema } from "@/server/domain/integrations/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { provider: rawProvider } = await params;
    const parsed = providerIdSchema.safeParse(rawProvider);
    if (!parsed.success) throw new AppError("BAD_REQUEST", "Unsupported integration provider.", 400);
    const result = await testSavedIntegration(context.workspace.id, parsed.data);
    return Response.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

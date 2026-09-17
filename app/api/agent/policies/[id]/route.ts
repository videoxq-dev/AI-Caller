import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { deletePolicy, updatePolicy } from "@/server/domain/onboarding/repository";
import { policyInputSchema } from "@/server/domain/onboarding/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(policyInputSchema.partial(), await request.json());
    const policy = await updatePolicy(context.workspace.id, id, input);
    if (!policy) throw new AppError("NOT_FOUND", "Policy not found.", 404);
    return Response.json({ policy });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const policy = await deletePolicy(context.workspace.id, id);
    if (!policy) throw new AppError("NOT_FOUND", "Policy not found.", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

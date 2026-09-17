import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { deleteService, updateService } from "@/server/domain/onboarding/repository";
import { serviceInputSchema } from "@/server/domain/onboarding/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(serviceInputSchema.partial(), await request.json());
    const service = await updateService(context.workspace.id, id, input);
    if (!service) throw new AppError("NOT_FOUND", "Service not found.", 404);
    return Response.json({ service });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const service = await deleteService(context.workspace.id, id);
    if (!service) throw new AppError("NOT_FOUND", "Service not found.", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

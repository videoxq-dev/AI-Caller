import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { deleteFAQ, updateFAQ } from "@/server/domain/onboarding/repository";
import { faqInputSchema } from "@/server/domain/onboarding/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(faqInputSchema.partial(), await request.json());
    const faq = await updateFAQ(context.workspace.id, id, input);
    if (!faq) throw new AppError("NOT_FOUND", "FAQ not found.", 404);
    return Response.json({ faq });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const faq = await deleteFAQ(context.workspace.id, id);
    if (!faq) throw new AppError("NOT_FOUND", "FAQ not found.", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

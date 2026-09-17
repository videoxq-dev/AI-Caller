import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getContactDetail, updateContact } from "@/server/domain/core/repository";
import { contactInputSchema } from "@/server/domain/core/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const contact = await getContactDetail(context.workspace.id, id);
    if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
    return Response.json({ contact });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(contactInputSchema, await request.json());
    const contact = await updateContact(context.workspace.id, id, input);
    return Response.json({ contact });
  } catch (error) {
    return toErrorResponse(error);
  }
}

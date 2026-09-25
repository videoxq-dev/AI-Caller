import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { revokeWorkspaceInvitation } from "@/server/auth/team-repository";
import { requireAgencyManagedWorkspace } from "@/server/agency/access";
import { AppError, toErrorResponse } from "@/server/http/errors";

const idSchema = z.string().uuid();

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; invitationId: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const raw = await params;
    const workspaceId = idSchema.parse(raw.workspaceId);
    const invitationId = idSchema.parse(raw.invitationId);
    await requireAgencyManagedWorkspace(session.user.id, workspaceId);
    const invitation = await revokeWorkspaceInvitation(workspaceId, invitationId, "OWNER");
    return Response.json({ invitation });
  } catch (error) {
    return toErrorResponse(error);
  }
}

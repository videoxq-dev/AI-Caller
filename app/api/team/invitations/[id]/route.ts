import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { revokeWorkspaceInvitation } from "@/server/auth/team-repository";
import { toErrorResponse } from "@/server/http/errors";

const idSchema = z.string().uuid();

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.manage");
    const { id } = await params;
    const invitation = await revokeWorkspaceInvitation(context.workspace.id, idSchema.parse(id));
    return Response.json({ invitation });
  } catch (error) {
    return toErrorResponse(error);
  }
}

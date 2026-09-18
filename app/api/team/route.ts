import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { listWorkspaceTeam } from "@/server/auth/team-repository";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.read");
    const team = await listWorkspaceTeam(context.workspace.id);
    return Response.json({ ...team, currentUserId: context.session.user.id, currentRole: context.membership.role });
  } catch (error) {
    return toErrorResponse(error);
  }
}

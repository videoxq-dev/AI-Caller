import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { listWorkspaceTeam } from "@/server/auth/team-repository";
import { getWorkspaceSeatUsage } from "@/server/billing/plans";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.read");
    const [team, seats] = await Promise.all([
      listWorkspaceTeam(context.workspace.id),
      getWorkspaceSeatUsage(context.workspace.id),
    ]);
    return Response.json({
      ...team,
      currentUserId: context.session.user.id,
      currentRole: context.membership.role,
      plan: {
        id: seats.plan.id,
        name: seats.plan.name,
        subUserLimit: seats.plan.subUserLimit,
        commercialSeatPackage: seats.commercialSeatPackage,
        activeSubUsers: seats.activeSubUsers,
        pendingInvitations: seats.pendingInvitations,
        usedSeats: seats.usedSeats,
        availableSeats: seats.availableSeats,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

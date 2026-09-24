import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { listWorkspaceTeam } from "@/server/auth/team-repository";
import { getWorkspaceSeatUsage } from "@/server/billing/plans";
import { requireAgencyManagedWorkspace } from "@/server/agency/access";
import { AppError, toErrorResponse } from "@/server/http/errors";

const idSchema = z.string().uuid();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const { workspaceId: rawWorkspaceId } = await params;
    const workspaceId = idSchema.parse(rawWorkspaceId);
    const workspace = await requireAgencyManagedWorkspace(session.user.id, workspaceId);

    const [team, seats] = await Promise.all([
      listWorkspaceTeam(workspaceId),
      getWorkspaceSeatUsage(workspaceId),
    ]);
    const members = team.members.map((member) => ({
      ...member,
      accessKind: member.userId === workspace.purchaserUserId
        ? "AGENCY_OWNER" as const
        : member.role === "OWNER"
          ? "CLIENT_OWNER" as const
          : "TEAM" as const,
    }));
    const invitations = team.invitations.map((invitation) => ({
      ...invitation,
      accessKind: invitation.role === "OWNER" ? "CLIENT_OWNER" as const : "TEAM" as const,
    }));

    return Response.json({
      workspace: {
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        kind: workspace.kind,
      },
      members,
      invitations,
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
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

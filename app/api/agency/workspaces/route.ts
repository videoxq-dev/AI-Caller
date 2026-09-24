import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { readActiveWorkspaceId } from "@/server/auth/active-workspace";
import { getOwnedWorkspaceCapacity, listCommercialWorkspacesForUser } from "@/server/auth/workspace-repository";
import { AppError, toErrorResponse } from "@/server/http/errors";

/** Purchaser-wide Agency management must not depend on the selected client workspace. */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);

    const capacity = await getOwnedWorkspaceCapacity(session.user.id);
    if (capacity.agencyClientLimit === null) {
      throw new AppError("AGENCY_REQUIRED", "Workspace management requires an active Agency package.", 403);
    }

    const workspaces = await listCommercialWorkspacesForUser(session.user.id);
    const selected = readActiveWorkspaceId(request.headers);
    return Response.json({
      workspaces,
      originalWorkspaceId: workspaces.find((workspace) => workspace.kind === "PRIMARY")?.workspaceId ?? null,
      activeWorkspaceId: workspaces.some((workspace) => workspace.workspaceId === selected) ? selected : null,
      capacity,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

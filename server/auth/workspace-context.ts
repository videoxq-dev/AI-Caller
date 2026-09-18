import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getWorkspacePlan } from "@/server/billing/plans";
import { AppError } from "@/server/http/errors";
import { readActiveWorkspaceId } from "./active-workspace";
import { ensureDefaultWorkspace, getMembership, getPrimaryMembership } from "./workspace-repository";

export async function resolveWorkspaceContext(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });

  if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
  await assertPlatformUserActive(session.user.id);

  const activeWorkspaceId = readActiveWorkspaceId(requestHeaders);
  let membership = activeWorkspaceId
    ? await getMembership(session.user.id, activeWorkspaceId)
    : await getPrimaryMembership(session.user.id);

  if (!membership) {
    membership = await getPrimaryMembership(session.user.id);
  }

  if (!membership) {
    membership = await ensureDefaultWorkspace({
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    });
  }

  if (membership.workspaceStatus === "SUSPENDED") {
    throw new AppError("WORKSPACE_SUSPENDED", "This workspace is suspended.", 403);
  }

  if (membership.role !== "OWNER") {
    const plan = await getWorkspacePlan(membership.workspaceId);
    if (plan.subUserLimit <= 0) {
      throw new AppError(
        "PLAN_SUBUSER_ACCESS_DISABLED",
        "This workspace plan does not include sub-user access.",
        403,
      );
    }
  }

  return {
    session,
    workspace: {
      id: membership.workspaceId,
      name: membership.workspaceName,
      status: membership.workspaceStatus,
    },
    membership: { role: membership.role },
  };
}

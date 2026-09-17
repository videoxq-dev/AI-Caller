import { auth } from "@/server/auth";
import { AppError } from "@/server/http/errors";
import { ensureDefaultWorkspace, getPrimaryMembership } from "./workspace-repository";

export async function resolveWorkspaceContext(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });

  if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);

  let membership = await getPrimaryMembership(session.user.id);
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

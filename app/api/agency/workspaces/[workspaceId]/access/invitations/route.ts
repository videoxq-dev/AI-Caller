import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { issueWorkspaceInvitation } from "@/server/auth/workspace-invitation-service";
import { requireAgencyManagedWorkspace } from "@/server/agency/access";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const idSchema = z.string().uuid();
const inputSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(["CLIENT_OWNER", "ADMIN", "STAFF"]),
});

export async function POST(
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
    const input = parseInput(inputSchema, await request.json());

    if (input.role === "CLIENT_OWNER" && workspace.kind !== "ADDITIONAL") {
      throw new AppError(
        "AGENCY_CLIENT_WORKSPACE_REQUIRED",
        "Client-owner access is available only for an Agency client workspace.",
        403,
      );
    }

    const created = await issueWorkspaceInvitation({
      workspaceId,
      workspaceName: workspace.workspaceName,
      invitedByUserId: session.user.id,
      inviterName: session.user.name,
      email: input.email,
      role: input.role === "CLIENT_OWNER" ? "OWNER" : input.role,
      rollbackActorRole: "OWNER",
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

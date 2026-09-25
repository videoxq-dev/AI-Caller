import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { listWorkspaceTeam, removeWorkspaceMember, updateWorkspaceMemberRole } from "@/server/auth/team-repository";
import { requireAgencyManagedWorkspace } from "@/server/agency/access";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const workspaceIdSchema = z.string().uuid();
const inputSchema = z.object({ role: z.enum(["ADMIN", "STAFF"]) });

async function contextFor(request: Request, rawWorkspaceId: string) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
  await assertPlatformUserActive(session.user.id);
  const workspaceId = workspaceIdSchema.parse(rawWorkspaceId);
  const workspace = await requireAgencyManagedWorkspace(session.user.id, workspaceId);
  return { session, workspaceId, workspace };
}

async function target(workspaceId: string, userId: string) {
  const team = await listWorkspaceTeam(workspaceId);
  const member = team.members.find((item) => item.userId === userId);
  if (!member) throw new AppError("MEMBER_NOT_FOUND", "Workspace member not found.", 404);
  return member;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; userId: string }> },
) {
  try {
    const raw = await params;
    const { session, workspaceId } = await contextFor(request, raw.workspaceId);
    const input = parseInput(inputSchema, await request.json());
    const member = await target(workspaceId, raw.userId);
    if (member.userId === session.user.id || member.role === "OWNER") {
      throw new AppError("OWNER_PROTECTED", "Owner access cannot be changed to a sub-user role here.", 409);
    }
    return Response.json({
      member: await updateWorkspaceMemberRole(workspaceId, member.userId, input.role),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; userId: string }> },
) {
  try {
    const raw = await params;
    const { session, workspaceId } = await contextFor(request, raw.workspaceId);
    const member = await target(workspaceId, raw.userId);
    if (member.userId === session.user.id) {
      throw new AppError("COMMERCIAL_OWNER_PROTECTED", "The Agency commercial owner cannot remove their own access.", 409);
    }
    return Response.json({
      member: await removeWorkspaceMember(workspaceId, member.userId),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

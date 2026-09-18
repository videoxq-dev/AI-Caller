import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { listWorkspaceTeam, removeWorkspaceMember, updateWorkspaceMemberRole } from "@/server/auth/team-repository";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({ role: z.enum(["ADMIN", "STAFF"]) });

async function targetMember(workspaceId: string, userId: string) {
  const team = await listWorkspaceTeam(workspaceId);
  const member = team.members.find((item) => item.userId === userId);
  if (!member) throw new AppError("MEMBER_NOT_FOUND", "Workspace member not found.", 404);
  return member;
}

function authorizeTarget(actorRole: "OWNER" | "ADMIN" | "STAFF", targetRole: "OWNER" | "ADMIN" | "STAFF", nextRole?: "ADMIN" | "STAFF") {
  if (targetRole === "OWNER") throw new AppError("OWNER_PROTECTED", "The workspace owner cannot be changed through team management.", 409);
  if (actorRole === "ADMIN" && (targetRole === "ADMIN" || nextRole === "ADMIN")) {
    throw new AppError("FORBIDDEN_ROLE_ASSIGNMENT", "Only the workspace owner can manage admins.", 403);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.manage");
    const { userId } = await params;
    const input = parseInput(inputSchema, await request.json());
    const target = await targetMember(context.workspace.id, userId);
    authorizeTarget(context.membership.role, target.role, input.role);
    const member = await updateWorkspaceMemberRole(context.workspace.id, userId, input.role);
    return Response.json({ member });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.manage");
    const { userId } = await params;
    const target = await targetMember(context.workspace.id, userId);
    authorizeTarget(context.membership.role, target.role);
    const member = await removeWorkspaceMember(context.workspace.id, userId);
    return Response.json({ member });
  } catch (error) {
    return toErrorResponse(error);
  }
}

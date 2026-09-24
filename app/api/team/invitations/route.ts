import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { issueWorkspaceInvitation } from "@/server/auth/workspace-invitation-service";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(["ADMIN", "STAFF"]).default("STAFF"),
});

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.manage");
    const input = parseInput(inputSchema, await request.json());
    if (context.membership.role === "ADMIN" && input.role === "ADMIN") {
      throw new AppError("FORBIDDEN_ROLE_ASSIGNMENT", "Only the workspace owner can invite another admin.", 403);
    }

    const created = await issueWorkspaceInvitation({
      workspaceId: context.workspace.id,
      workspaceName: context.workspace.name,
      invitedByUserId: context.session.user.id,
      inviterName: context.session.user.name,
      email: input.email,
      role: input.role,
      rollbackActorRole: context.membership.role as "OWNER" | "ADMIN",
    });

    return Response.json(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

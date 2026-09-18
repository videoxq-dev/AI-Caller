import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { createWorkspaceInvitation } from "@/server/auth/team-repository";
import { getEnv } from "@/server/env";
import { enqueueUniqueJob } from "@/server/jobs";
import { TEAM_INVITATION_EMAIL } from "@/server/jobs/queues";
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

    const created = await createWorkspaceInvitation({
      workspaceId: context.workspace.id,
      invitedByUserId: context.session.user.id,
      email: input.email,
      role: input.role,
    });

    const baseUrl = getEnv().BETTER_AUTH_URL;
    const acceptUrl = new URL("/team/invite", baseUrl);
    acceptUrl.searchParams.set("token", created.token);
    await enqueueUniqueJob(TEAM_INVITATION_EMAIL, created.invitation.id, {
      to: created.invitation.email,
      inviterName: context.session.user.name,
      workspaceName: context.workspace.name,
      acceptUrl: acceptUrl.toString(),
    });

    return Response.json({ invitation: created.invitation }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { createWorkspaceInvitation, revokeWorkspaceInvitation } from "@/server/auth/team-repository";
import { getEnv } from "@/server/env";
import { isGuardedE2EFixtureMode } from "@/server/e2e-mode";
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
    const env = getEnv();
    const e2e = isGuardedE2EFixtureMode();
    if (!e2e && (!env.SMTP_URL || !env.SMTP_FROM)) {
      throw new AppError("TEAM_EMAIL_NOT_CONFIGURED", "Configure SMTP before inviting team members.", 409);
    }

    if (context.membership.role === "ADMIN" && input.role === "ADMIN") {
      throw new AppError("FORBIDDEN_ROLE_ASSIGNMENT", "Only the workspace owner can invite another admin.", 403);
    }

    const created = await createWorkspaceInvitation({
      workspaceId: context.workspace.id,
      invitedByUserId: context.session.user.id,
      email: input.email,
      role: input.role,
    });

    const acceptUrl = new URL("/team/invite", env.BETTER_AUTH_URL);
    acceptUrl.searchParams.set("token", created.token);
    try {
      const jobId = await enqueueUniqueJob(TEAM_INVITATION_EMAIL, created.invitation.id, {
        to: created.invitation.email,
        inviterName: context.session.user.name,
        workspaceName: context.workspace.name,
        acceptUrl: acceptUrl.toString(),
      });
      if (!jobId) throw new Error("Invitation email could not be queued.");
    } catch (error) {
      await revokeWorkspaceInvitation(context.workspace.id, created.invitation.id).catch(() => undefined);
      throw error;
    }

    return Response.json({
      invitation: created.invitation,
      ...(e2e ? { e2eToken: created.token } : {}),
    }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

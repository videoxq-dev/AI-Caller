import { createWorkspaceInvitation, revokeWorkspaceInvitation, type InviteRole } from "@/server/auth/team-repository";
import { getEnv } from "@/server/env";
import { isGuardedE2EFixtureMode } from "@/server/e2e-mode";
import { AppError } from "@/server/http/errors";
import { enqueueUniqueJob } from "@/server/jobs";
import { TEAM_INVITATION_EMAIL } from "@/server/jobs/queues";

export async function issueWorkspaceInvitation(input: {
  workspaceId: string;
  workspaceName: string;
  invitedByUserId: string;
  inviterName: string;
  email: string;
  role: InviteRole;
  rollbackActorRole: "OWNER" | "ADMIN";
}) {
  const env = getEnv();
  const e2e = isGuardedE2EFixtureMode();
  if (!e2e && (!env.SMTP_URL || !env.SMTP_FROM)) {
    throw new AppError("TEAM_EMAIL_NOT_CONFIGURED", "Configure SMTP before inviting team members.", 409);
  }

  const created = await createWorkspaceInvitation({
    workspaceId: input.workspaceId,
    invitedByUserId: input.invitedByUserId,
    email: input.email,
    role: input.role,
  });

  const acceptUrl = new URL("/team/invite", env.BETTER_AUTH_URL);
  acceptUrl.searchParams.set("token", created.token);
  try {
    const jobId = await enqueueUniqueJob(TEAM_INVITATION_EMAIL, created.invitation.id, {
      to: created.invitation.email,
      inviterName: input.inviterName,
      workspaceName: input.workspaceName,
      acceptUrl: acceptUrl.toString(),
    });
    if (!jobId) throw new Error("Invitation email could not be queued.");
  } catch (error) {
    await revokeWorkspaceInvitation(
      input.workspaceId,
      created.invitation.id,
      input.rollbackActorRole,
    ).catch(() => undefined);
    throw error;
  }

  return {
    invitation: created.invitation,
    ...(e2e ? { e2eToken: created.token } : {}),
  };
}

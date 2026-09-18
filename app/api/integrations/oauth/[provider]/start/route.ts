import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { createOAuthState, getOAuthAuthorizationUrl, type OAuthProviderId } from "@/server/providers/oauth";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const { provider: rawProvider } = await params;
    if (rawProvider !== "google" && rawProvider !== "outlook") throw new AppError("BAD_REQUEST", "Unsupported OAuth provider.", 400);
    const provider = rawProvider as OAuthProviderId;
    const returnTo = new URL(request.url).searchParams.get("return");
    const state = createOAuthState({ provider, workspaceId: context.workspace.id, returnTo });
    return Response.redirect(getOAuthAuthorizationUrl(provider, state));
  } catch (error) {
    return toErrorResponse(error);
  }
}

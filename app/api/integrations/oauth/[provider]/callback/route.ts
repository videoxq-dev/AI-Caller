import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { saveVerifiedIntegration } from "@/server/domain/integrations/repository";
import { exchangeOAuthCode, verifyOAuthState, type OAuthProviderId } from "@/server/providers/oauth";
import { getEnv } from "@/server/env";

function redirectWithStatus(path: string, provider: string, status: "connected" | "error", message?: string) {
  const url = new URL(path, getEnv().BETTER_AUTH_URL);
  url.searchParams.set("provider", provider);
  url.searchParams.set("connection", status);
  if (message) url.searchParams.set("message", message.slice(0, 180));
  return Response.redirect(url);
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  let returnTo = "/integrations";
  let provider = "calendar";
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { provider: rawProvider } = await params;
    if (rawProvider !== "google" && rawProvider !== "outlook") throw new Error("Unsupported OAuth provider.");
    provider = rawProvider;
    const url = new URL(request.url);
    const stateValue = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!stateValue || !code) throw new Error(url.searchParams.get("error_description") ?? "Calendar authorization was not completed.");
    const state = verifyOAuthState(stateValue);
    returnTo = state.returnTo;
    if (state.provider !== rawProvider || state.workspaceId !== context.workspace.id) throw new Error("OAuth authorization does not match this workspace.");
    const result = await exchangeOAuthCode(rawProvider as OAuthProviderId, code);
    await saveVerifiedIntegration(context.workspace.id, { provider: rawProvider as OAuthProviderId, category: "CALENDAR", mode: "BYOP", credentials: result.credentials, settings: result.settings });
    return redirectWithStatus(returnTo, rawProvider, "connected");
  } catch (error) {
    return redirectWithStatus(returnTo, provider, "error", error instanceof Error ? error.message : "Calendar connection failed.");
  }
}

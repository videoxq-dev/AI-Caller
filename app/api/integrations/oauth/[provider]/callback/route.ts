import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { bindCapability, saveVerifiedIntegration } from "@/server/domain/integrations/repository";
import { exchangeOAuthCode, verifyOAuthState, type OAuthProviderId } from "@/server/providers/oauth";
import { getEnv } from "@/server/env";
import { requireProviderIntegrationEntitlement } from "@/server/commerce/workspace-entitlements";

function redirectWithStatus(path: string, provider: string, status: "connected" | "error", message?: string) {
  const url = new URL(path, getEnv().BETTER_AUTH_URL);
  url.searchParams.set("provider", provider);
  url.searchParams.set("connection", status);
  if (message) url.searchParams.set("message", message.slice(0, 180));
  return Response.redirect(url);
}

function publicFailureMessage(provider: string) {
  if (provider === "google") return "Google Calendar connection failed. Please try again.";
  if (provider === "outlook") return "Microsoft Outlook connection failed. Please try again.";
  return "Calendar connection failed. Please try again.";
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
    if (!stateValue) throw new Error("Calendar authorization state is missing.");

    const state = verifyOAuthState(stateValue);
    returnTo = state.returnTo;
    if (state.provider !== rawProvider || state.workspaceId !== context.workspace.id) {
      throw new Error("OAuth authorization does not match this workspace.");
    }

    await requireProviderIntegrationEntitlement(context.workspace.id, rawProvider);

    const code = url.searchParams.get("code");
    if (!code) {
      return redirectWithStatus(returnTo, provider, "error", "Calendar authorization was not completed.");
    }

    const result = await exchangeOAuthCode(rawProvider as OAuthProviderId, code);
    await saveVerifiedIntegration(context.workspace.id, {
      provider: rawProvider as OAuthProviderId,
      category: "CALENDAR",
      mode: "BYOP",
      credentials: result.credentials,
      settings: result.settings,
    });
    await bindCapability(context.workspace.id, "CALENDAR", "BYOP", rawProvider);

    return redirectWithStatus(returnTo, rawProvider, "connected");
  } catch {
    return redirectWithStatus(returnTo, provider, "error", publicFailureMessage(provider));
  }
}

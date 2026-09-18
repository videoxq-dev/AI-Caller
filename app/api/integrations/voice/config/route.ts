import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getPrivateIntegration } from "@/server/domain/integrations/repository";
import { getEnv } from "@/server/env";
import { toErrorResponse } from "@/server/http/errors";
import { resolveProviderRoute } from "@/server/providers/resolver";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";

function callbackUrl(workspaceId: string) {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/api/webhooks/voice/telnyx/${workspaceId}`;
}

function legacySettings(encryptedCredentials: Record<string, unknown> | null | undefined) {
  if (!encryptedCredentials) return {} as Record<string, string>;
  try {
    return decryptIntegrationCredentials<Record<string, string>>(encryptedCredentials as EncryptedSecretEnvelope);
  } catch {
    return {} as Record<string, string>;
  }
}

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const route = await resolveProviderRoute(context.workspace.id, "VOICE");
    const active = route?.mode === "BYOP" && route.provider === "telnyx";
    const integration = await getPrivateIntegration(context.workspace.id, "telnyx");
    const settings = integration?.settings && typeof integration.settings === "object"
      ? integration.settings as Record<string, unknown>
      : {};
    const legacy = legacySettings(integration?.encryptedCredentials);
    const receiverNumber = typeof settings.phone === "string" && settings.phone.trim()
      ? settings.phone.trim()
      : legacy.phone?.trim() || null;

    return Response.json({
      configured: Boolean(active && integration?.status === "CONNECTED"),
      provider: "telnyx",
      webhookUrl: callbackUrl(context.workspace.id),
      receiverNumber,
      webhookPublicKeyConfigured: Boolean(settings.webhookPublicKey || legacy.webhookPublicKey),
      connectionIdConfigured: Boolean(settings.connectionId || legacy.connectionId),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

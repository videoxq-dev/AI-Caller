import { getPrivateIntegration } from "@/server/domain/integrations/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import { resolveProviderRoute } from "@/server/providers/resolver";
import type { VoiceProvider } from "@/server/providers/contracts";
import { createTelnyxVoiceProvider } from "./telnyx";
import { createE2EVoiceProvider, isE2EProviderFixtureMode } from "@/server/providers/e2e-fixtures";

export type VoiceProviderName = "telnyx";

export type VoiceRuntime = {
  workspaceId: string;
  mode: "BYOP";
  providerName: VoiceProviderName;
  integrationId: string;
  receiverNumber: string;
  provider: VoiceProvider;
};

type CredentialMap = Record<string, string>;

function required(values: Record<string, unknown>, key: string, label: string) {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function credentials(envelope: Record<string, unknown> | null) {
  if (!envelope) throw new Error("No saved credentials are available for this voice integration.");
  return decryptIntegrationCredentials<CredentialMap>(envelope as EncryptedSecretEnvelope);
}

export async function resolveVoiceRuntime(
  workspaceId: string,
  requestedProvider: VoiceProviderName = "telnyx",
  fetcher: typeof fetch = fetch,
): Promise<VoiceRuntime> {
  const route = await resolveProviderRoute(workspaceId, "VOICE");
  if (!route || route.mode !== "BYOP") {
    throw new Error("No BYOP voice provider route is configured for this workspace.");
  }
  if (route.provider !== requestedProvider) {
    throw new Error("The webhook provider is not the active voice provider for this workspace.");
  }
  if (requestedProvider !== "telnyx") {
    throw new Error("Milestone 7 currently supports Telnyx for inbound voice.");
  }
  if (!route.integrationId) throw new Error("The active voice integration is missing.");

  const integration = await getPrivateIntegration(workspaceId, requestedProvider);
  if (!integration || integration.id !== route.integrationId || integration.status !== "CONNECTED") {
    throw new Error("The active voice integration is not connected.");
  }

  const secret = credentials(integration.encryptedCredentials);
  const settings = integration.settings ?? {};
  const phone = typeof settings.phone === "string" && settings.phone.trim()
    ? settings.phone
    : required(secret, "phone", "Telnyx voice phone number");
  const webhookPublicKey = typeof settings.webhookPublicKey === "string" && settings.webhookPublicKey.trim()
    ? settings.webhookPublicKey
    : required(secret, "webhookPublicKey", "Telnyx webhook public key");

  return {
    workspaceId,
    mode: "BYOP",
    providerName: "telnyx",
    integrationId: integration.id,
    receiverNumber: normalizePhone(phone),
    provider: (() => {
      const base = createTelnyxVoiceProvider({
        apiKey: required(secret, "apiKey", "Telnyx API key"),
        webhookPublicKey,
        fetcher,
      });
      return isE2EProviderFixtureMode() ? createE2EVoiceProvider(base) : base;
    })(),
  };
}

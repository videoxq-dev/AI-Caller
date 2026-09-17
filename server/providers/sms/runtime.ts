import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import { getPrivateIntegration } from "@/server/domain/integrations/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { resolveProviderRoute } from "../resolver";
import type { SMSProvider } from "../contracts";
import { createPlivoSmsProvider } from "./plivo";
import { createTelnyxSmsProvider } from "./telnyx";
import { createTwilioSmsProvider } from "./twilio";

export type SmsProviderName = "telnyx" | "twilio" | "plivo";

export type SmsRuntime = {
  workspaceId: string;
  mode: "BYOP";
  providerName: SmsProviderName;
  integrationId: string;
  senderNumber: string;
  provider: SMSProvider;
};

type CredentialMap = Record<string, string>;

function required(values: Record<string, unknown>, key: string, label: string) {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function credentials(envelope: Record<string, unknown> | null): CredentialMap {
  if (!envelope) throw new Error("No saved credentials are available for this SMS integration.");
  return decryptIntegrationCredentials<CredentialMap>(envelope as EncryptedSecretEnvelope);
}

export async function resolveSmsRuntime(
  workspaceId: string,
  requestedProvider: SmsProviderName,
  fetcher: typeof fetch = fetch,
): Promise<SmsRuntime> {
  const route = await resolveProviderRoute(workspaceId, "SMS");
  if (!route) throw new Error("No SMS provider route is configured for this workspace.");
  if (route.mode !== "BYOP") throw new Error("Hosted SMS routing is not configured yet.");
  if (route.provider !== requestedProvider) throw new Error("The webhook provider is not the active SMS provider for this workspace.");
  if (!route.integrationId) throw new Error("The active SMS integration is missing.");

  const integration = await getPrivateIntegration(workspaceId, requestedProvider);
  if (!integration || integration.id !== route.integrationId || integration.status !== "CONNECTED") {
    throw new Error("The active SMS integration is not connected.");
  }

  const secret = credentials(integration.encryptedCredentials);
  const settings = integration.settings ?? {};
  const senderNumber = normalizePhone(
    typeof settings.phone === "string" && settings.phone.trim()
      ? settings.phone
      : required(secret, "phone", "SMS phone number"),
  );

  let provider: SMSProvider;
  switch (requestedProvider) {
    case "twilio":
      provider = createTwilioSmsProvider({
        accountSid: required(secret, "sid", "Twilio Account SID"),
        authToken: required(secret, "authToken", "Twilio Auth Token"),
        fetcher,
      });
      break;
    case "plivo":
      provider = createPlivoSmsProvider({
        authId: required(secret, "authId", "Plivo Auth ID"),
        authToken: required(secret, "authToken", "Plivo Auth Token"),
        fetcher,
      });
      break;
    case "telnyx":
      provider = createTelnyxSmsProvider({
        apiKey: required(secret, "apiKey", "Telnyx API key"),
        webhookPublicKey: typeof settings.webhookPublicKey === "string" && settings.webhookPublicKey.trim()
          ? settings.webhookPublicKey
          : required(secret, "webhookPublicKey", "Telnyx webhook public key"),
        fetcher,
      });
      break;
  }

  return {
    workspaceId,
    mode: "BYOP",
    providerName: requestedProvider,
    integrationId: route.integrationId,
    senderNumber,
    provider,
  };
}

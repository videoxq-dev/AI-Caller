import { getEnv } from "@/server/env";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import { getCommunicationSetup, getPrivateIntegration } from "@/server/domain/integrations/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { resolveProviderRoute } from "../resolver";
import type { SMSProvider } from "../contracts";
import { createPlivoSmsProvider } from "./plivo";
import { createTelnyxSmsProvider } from "./telnyx";
import { createTwilioSmsProvider } from "./twilio";

export type SmsProviderName = "telnyx" | "twilio" | "plivo";

export type SmsRuntime = {
  workspaceId: string;
  mode: "HOSTED" | "BYOP";
  providerName: SmsProviderName;
  integrationId: string | null;
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

function createProvider(provider: SmsProviderName, secret: Record<string, unknown>, settings: Record<string, unknown>, fetcher: typeof fetch) {
  switch (provider) {
    case "twilio":
      return createTwilioSmsProvider({
        accountSid: required(secret, "sid", "Twilio Account SID"),
        authToken: required(secret, "authToken", "Twilio Auth Token"),
        fetcher,
      });
    case "plivo":
      return createPlivoSmsProvider({
        authId: required(secret, "authId", "Plivo Auth ID"),
        authToken: required(secret, "authToken", "Plivo Auth Token"),
        fetcher,
      });
    case "telnyx":
      return createTelnyxSmsProvider({
        apiKey: required(secret, "apiKey", "Telnyx API key"),
        webhookPublicKey: typeof settings.webhookPublicKey === "string" && settings.webhookPublicKey.trim()
          ? settings.webhookPublicKey
          : required(secret, "webhookPublicKey", "Telnyx webhook public key"),
        fetcher,
      });
  }
}

async function hostedSenderNumber(workspaceId: string) {
  const setup = await getCommunicationSetup(workspaceId) as {
    voice?: { number?: unknown };
    sms?: { numberMode?: unknown; number?: unknown };
  } | null;
  const usesSeparateNumber = setup?.sms?.numberMode === "separate";
  const candidate = usesSeparateNumber ? setup?.sms?.number : setup?.voice?.number;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error("A hosted SMS sender number has not been assigned to this workspace.");
  }
  return normalizePhone(candidate);
}

function hostedProviderConfig(provider: SmsProviderName) {
  const env = getEnv();
  switch (provider) {
    case "twilio":
      return {
        secret: {
          sid: env.HOSTED_SMS_TWILIO_ACCOUNT_SID,
          authToken: env.HOSTED_SMS_TWILIO_AUTH_TOKEN,
        },
        settings: {},
      };
    case "plivo":
      return {
        secret: {
          authId: env.HOSTED_SMS_PLIVO_AUTH_ID,
          authToken: env.HOSTED_SMS_PLIVO_AUTH_TOKEN,
        },
        settings: {},
      };
    case "telnyx":
      return {
        secret: {
          apiKey: env.HOSTED_SMS_TELNYX_API_KEY,
        },
        settings: {
          webhookPublicKey: env.HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY,
        },
      };
  }
}

export async function resolveSmsRuntime(
  workspaceId: string,
  requestedProvider: SmsProviderName,
  fetcher: typeof fetch = fetch,
): Promise<SmsRuntime> {
  const route = await resolveProviderRoute(workspaceId, "SMS");
  if (!route) throw new Error("No SMS provider route is configured for this workspace.");

  if (route.mode === "HOSTED") {
    const providerName = getEnv().HOSTED_SMS_PROVIDER;
    if (requestedProvider !== providerName) throw new Error("The webhook provider is not the active hosted SMS provider.");
    const config = hostedProviderConfig(providerName);
    return {
      workspaceId,
      mode: "HOSTED",
      providerName,
      integrationId: null,
      senderNumber: await hostedSenderNumber(workspaceId),
      provider: createProvider(providerName, config.secret, config.settings, fetcher),
    };
  }

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

  return {
    workspaceId,
    mode: "BYOP",
    providerName: requestedProvider,
    integrationId: route.integrationId,
    senderNumber,
    provider: createProvider(requestedProvider, secret, settings, fetcher),
  };
}

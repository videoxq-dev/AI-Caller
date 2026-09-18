import { getHostedPhoneRuntimeRecord, getHostedPhoneWebhookRecord } from "@/server/phone-numbers/service";
import { getHostedTelnyxCredentials } from "@/server/providers/telnyx-platform";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import { getPrivateIntegration } from "@/server/domain/integrations/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { createE2ESmsProvider, isE2EProviderFixtureMode } from "../e2e-fixtures";
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
  serviceStatus: "ACTIVE" | "PAST_DUE" | "SUSPENDED" | null;
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
  let runtimeProvider: SMSProvider;
  switch (provider) {
    case "twilio":
      runtimeProvider = createTwilioSmsProvider({
        accountSid: required(secret, "sid", "Twilio Account SID"),
        authToken: required(secret, "authToken", "Twilio Auth Token"),
        fetcher,
      });
      break;
    case "plivo":
      runtimeProvider = createPlivoSmsProvider({
        authId: required(secret, "authId", "Plivo Auth ID"),
        authToken: required(secret, "authToken", "Plivo Auth Token"),
        fetcher,
      });
      break;
    case "telnyx":
      runtimeProvider = createTelnyxSmsProvider({
        apiKey: required(secret, "apiKey", "Telnyx API key"),
        webhookPublicKey: typeof settings.webhookPublicKey === "string" && settings.webhookPublicKey.trim()
          ? settings.webhookPublicKey
          : required(secret, "webhookPublicKey", "Telnyx webhook public key"),
        fetcher,
      });
      break;
  }
  return isE2EProviderFixtureMode() ? createE2ESmsProvider(runtimeProvider) : runtimeProvider;
}

async function hostedNumber(workspaceId: string, allowSuspended: boolean) {
  const number = allowSuspended
    ? await getHostedPhoneWebhookRecord(workspaceId)
    : await getHostedPhoneRuntimeRecord(workspaceId);
  return {
    senderNumber: normalizePhone(number.phoneNumber),
    serviceStatus: number.status as "ACTIVE" | "PAST_DUE" | "SUSPENDED",
  };
}

function hostedProviderConfig() {
  const hosted = getHostedTelnyxCredentials();
  return {
    secret: { apiKey: hosted.apiKey },
    settings: { webhookPublicKey: hosted.webhookPublicKey },
  };
}

async function resolveSmsRuntimeInternal(
  workspaceId: string,
  requestedProvider: SmsProviderName,
  fetcher: typeof fetch,
  allowSuspended: boolean,
): Promise<SmsRuntime> {
  const route = await resolveProviderRoute(workspaceId, "SMS");
  if (!route) throw new Error("No SMS provider route is configured for this workspace.");

  if (route.mode === "HOSTED") {
    const providerName: SmsProviderName = "telnyx";
    if (requestedProvider !== providerName) throw new Error("Managed SMS uses the Telnyx adapter.");
    const config = hostedProviderConfig();
    const number = await hostedNumber(workspaceId, allowSuspended);
    return {
      workspaceId,
      mode: "HOSTED",
      providerName,
      integrationId: null,
      senderNumber: number.senderNumber,
      serviceStatus: number.serviceStatus,
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
    serviceStatus: null,
    provider: createProvider(requestedProvider, secret, settings, fetcher),
  };
}


export async function resolveSmsRuntime(
  workspaceId: string,
  requestedProvider: SmsProviderName,
  fetcher: typeof fetch = fetch,
): Promise<SmsRuntime> {
  return resolveSmsRuntimeInternal(workspaceId, requestedProvider, fetcher, false);
}

export async function resolveSmsWebhookRuntime(
  workspaceId: string,
  requestedProvider: SmsProviderName,
  fetcher: typeof fetch = fetch,
): Promise<SmsRuntime> {
  return resolveSmsRuntimeInternal(workspaceId, requestedProvider, fetcher, true);
}

function isSmsProviderName(value: string): value is SmsProviderName {
  return value === "telnyx" || value === "twilio" || value === "plivo";
}

export async function resolveSmsRuntimeForWorkspace(
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<SmsRuntime> {
  const route = await resolveProviderRoute(workspaceId, "SMS");
  if (!route) throw new Error("No SMS provider route is configured for this workspace.");
  const providerName = route.mode === "HOSTED" ? "telnyx" : route.provider;
  if (!isSmsProviderName(providerName)) throw new Error("The active SMS provider is not supported.");
  return resolveSmsRuntime(workspaceId, providerName, fetcher);
}

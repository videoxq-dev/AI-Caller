import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { capabilityBindings, integrations } from "@/db/schema";
import { getPrivateIntegration } from "@/server/domain/integrations/repository";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import { resolveProviderRoute } from "@/server/providers/resolver";
import type { WhatsAppProvider } from "@/server/providers/contracts";
import { createMetaWhatsAppProvider } from "./meta-cloud";

export type WhatsAppRuntime = {
  workspaceId: string;
  integrationId: string;
  phoneNumberId: string;
  wabaId: string;
  mode: "BYOP";
  providerName: "whatsapp";
  provider: WhatsAppProvider;
};

type CredentialMap = Record<string, string>;

function credentials(envelope: Record<string, unknown> | null) {
  if (!envelope) throw new Error("No saved credentials are available for this WhatsApp integration.");
  return decryptIntegrationCredentials<CredentialMap>(envelope as EncryptedSecretEnvelope);
}

function required(values: Record<string, unknown>, key: string, label: string) {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function runtimeFromIntegration(row: {
  workspaceId: string;
  id: string;
  encryptedCredentials: Record<string, unknown> | null;
  settings: Record<string, unknown>;
}, fetcher: typeof fetch): WhatsAppRuntime {
  const secret = credentials(row.encryptedCredentials);
  const phoneNumberId = typeof row.settings.phoneNumberId === "string" && row.settings.phoneNumberId.trim()
    ? row.settings.phoneNumberId.trim()
    : required(secret, "phoneNumberId", "WhatsApp phone number ID");
  const wabaId = typeof row.settings.wabaId === "string" && row.settings.wabaId.trim()
    ? row.settings.wabaId.trim()
    : required(secret, "wabaId", "WhatsApp Business Account ID");
  return {
    workspaceId: row.workspaceId,
    integrationId: row.id,
    phoneNumberId,
    wabaId,
    mode: "BYOP",
    providerName: "whatsapp",
    provider: createMetaWhatsAppProvider({ accessToken: required(secret, "accessToken", "Meta access token") }, {}, fetcher),
  };
}

export async function resolveWhatsAppRuntimeByPhoneNumberId(phoneNumberId: string, fetcher: typeof fetch = fetch) {
  const rows = await db.select({
    workspaceId: integrations.workspaceId,
    id: integrations.id,
    encryptedCredentials: integrations.encryptedCredentials,
    settings: integrations.settings,
  }).from(integrations).innerJoin(capabilityBindings, and(
    eq(capabilityBindings.workspaceId, integrations.workspaceId),
    eq(capabilityBindings.integrationId, integrations.id),
    eq(capabilityBindings.capability, "WHATSAPP"),
    eq(capabilityBindings.mode, "BYOP"),
  )).where(and(
    eq(integrations.provider, "whatsapp"),
    eq(integrations.status, "CONNECTED"),
    sql`${integrations.settings} @> ${JSON.stringify({ phoneNumberId })}::jsonb`,
  )).limit(2);

  if (rows.length === 0) throw new Error("No active WhatsApp integration matches this phone number ID.");
  if (rows.length > 1) throw new Error("Multiple active WhatsApp integrations match this phone number ID.");
  return runtimeFromIntegration(rows[0], fetcher);
}

export async function resolveWhatsAppRuntimeForWorkspace(workspaceId: string, fetcher: typeof fetch = fetch) {
  const route = await resolveProviderRoute(workspaceId, "WHATSAPP");
  if (!route || route.mode !== "BYOP" || route.provider !== "whatsapp" || !route.integrationId) {
    throw new Error("No active WhatsApp provider route is configured for this workspace.");
  }
  const integration = await getPrivateIntegration(workspaceId, "whatsapp");
  if (!integration || integration.id !== route.integrationId || integration.status !== "CONNECTED") {
    throw new Error("The active WhatsApp integration is not connected.");
  }
  return runtimeFromIntegration({
    workspaceId,
    id: integration.id,
    encryptedCredentials: integration.encryptedCredentials,
    settings: integration.settings,
  }, fetcher);
}

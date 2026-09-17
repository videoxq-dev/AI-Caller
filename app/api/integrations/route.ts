import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import {
  bindCapability,
  getPrivateIntegration,
  listIntegrations,
  saveIntegration,
  setIntegrationStatus,
  testSavedIntegration,
} from "@/server/domain/integrations/repository";
import { integrationSaveSchema, providerIdSchema } from "@/server/domain/integrations/schemas";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";

const disconnectSchema = z.object({
  provider: providerIdSchema,
  status: z.literal("DISCONNECTED"),
});

const directCredentialProviders = new Set([
  "plivo",
  "telnyx",
  "twilio",
  "openai",
  "gemini",
  "openrouter",
  "calendly",
  "calcom",
]);

const categoryByProvider: Record<string, "AI" | "COMMUNICATION" | "WHATSAPP" | "CALENDAR"> = {
  plivo: "COMMUNICATION",
  telnyx: "COMMUNICATION",
  twilio: "COMMUNICATION",
  whatsapp: "WHATSAPP",
  credits: "AI",
  openai: "AI",
  gemini: "AI",
  openrouter: "AI",
  google: "CALENDAR",
  outlook: "CALENDAR",
  calendly: "CALENDAR",
  calcom: "CALENDAR",
};

const credentialKeys: Record<string, readonly string[]> = {
  plivo: ["authId", "authToken", "phone"],
  telnyx: ["apiKey", "connectionId", "phone"],
  twilio: ["sid", "authToken", "phone"],
  openai: ["apiKey"],
  gemini: ["apiKey"],
  openrouter: ["apiKey"],
  calendly: ["token"],
  calcom: ["apiKey"],
};

const settingKeys: Record<string, readonly string[]> = {
  openai: ["model"],
  gemini: ["model"],
  openrouter: ["model", "siteUrl"],
  calendly: ["org"],
  calcom: ["slug"],
};

const defaultSettingsByProvider: Record<string, Record<string, unknown>> = {
  openai: { model: "gpt-5.6" },
  gemini: { model: "gemini-3.8-flash" },
  openrouter: { model: "openai/gpt-5.6-sol" },
};

function filterCredentials(provider: string, credentials: Record<string, string>) {
  const allowed = new Set(credentialKeys[provider] ?? []);
  return Object.fromEntries(
    Object.entries(credentials)
      .filter(([key, value]) => allowed.has(key) && value.trim().length > 0)
      .map(([key, value]) => [key, value.trim()]),
  );
}

function filterSettings(provider: string, settings: Record<string, unknown>) {
  const allowed = new Set(settingKeys[provider] ?? []);
  return Object.fromEntries(Object.entries(settings).filter(([key]) => allowed.has(key)));
}

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json({ integrations: await listIntegrations(context.workspace.id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(integrationSaveSchema, await request.json());

    if (!directCredentialProviders.has(input.provider)) {
      const message = input.provider === "whatsapp"
        ? "Connect WhatsApp through Meta Embedded Signup."
        : input.provider === "google" || input.provider === "outlook"
          ? "Connect this calendar through OAuth."
          : "This integration is configured through its dedicated connection flow.";
      throw new AppError("BAD_REQUEST", message, 400);
    }

    const existing = await getPrivateIntegration(context.workspace.id, input.provider);
    const suppliedCredentials = filterCredentials(input.provider, input.credentials);
    let credentials = suppliedCredentials;

    if (existing?.encryptedCredentials && Object.keys(suppliedCredentials).length > 0) {
      const existingCredentials = decryptIntegrationCredentials<Record<string, string>>(
        existing.encryptedCredentials as EncryptedSecretEnvelope,
      );
      credentials = { ...existingCredentials, ...suppliedCredentials };
    }

    const normalized = {
      ...input,
      category: categoryByProvider[input.provider],
      mode: "BYOP" as const,
      credentials,
      settings: {
        ...(defaultSettingsByProvider[input.provider] ?? {}),
        ...filterSettings(input.provider, existing?.settings ?? {}),
        ...filterSettings(input.provider, input.settings),
      },
    };

    const integration = await saveIntegration(context.workspace.id, normalized);
    const test = await testSavedIntegration(context.workspace.id, input.provider);

    if (test.ok) {
      if (normalized.category === "AI") await bindCapability(context.workspace.id, "AI_TEXT", "BYOP", input.provider);
      if (normalized.category === "CALENDAR") await bindCapability(context.workspace.id, "CALENDAR", "BYOP", input.provider);
    }

    return Response.json({ integration: test.integration ?? integration, test: { ok: test.ok, error: test.ok ? null : test.error } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(disconnectSchema, await request.json());
    return Response.json({ integration: await setIntegrationStatus(context.workspace.id, input.provider, "DISCONNECTED") });
  } catch (error) {
    return toErrorResponse(error);
  }
}

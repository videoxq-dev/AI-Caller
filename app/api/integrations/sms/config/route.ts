import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getPrivateIntegration, saveIntegration } from "@/server/domain/integrations/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { resolveProviderRoute } from "@/server/providers/resolver";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";

const providerSchema = z.enum(["telnyx", "twilio", "plivo"]);
const updateSchema = z.object({
  provider: providerSchema,
  phone: z.string().trim().min(7).max(80).optional(),
  webhookPublicKey: z.string().trim().min(32).max(5000).optional(),
}).refine((input) => input.phone !== undefined || input.webhookPublicKey !== undefined, {
  message: "Provide at least one SMS configuration value.",
});

function callbackUrl(provider: string, workspaceId: string) {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/api/webhooks/sms/${provider}/${workspaceId}`;
}

function legacyPublicSettings(encryptedCredentials: Record<string, unknown> | null | undefined) {
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
    const requestedProvider = providerSchema.safeParse(new URL(request.url).searchParams.get("provider"));
    const route = await resolveProviderRoute(context.workspace.id, "SMS");
    const activeProvider = route
      ? route.mode === "HOSTED" ? getEnv().HOSTED_SMS_PROVIDER : providerSchema.parse(route.provider)
      : null;
    const provider = requestedProvider.success ? requestedProvider.data : activeProvider;
    if (!provider) return Response.json({ configured: false, mode: null, provider: null, webhookUrl: null });

    const integration = await getPrivateIntegration(context.workspace.id, provider);
    const settings = integration?.settings && typeof integration.settings === "object"
      ? integration.settings as Record<string, unknown>
      : {};
    const legacy = legacyPublicSettings(integration?.encryptedCredentials);
    const senderNumber = typeof settings.phone === "string" && settings.phone.trim()
      ? settings.phone
      : legacy.phone ?? null;
    const active = activeProvider === provider;
    const hosted = active && route?.mode === "HOSTED";

    return Response.json({
      configured: active,
      mode: active ? route?.mode ?? null : null,
      provider,
      webhookUrl: callbackUrl(provider, context.workspace.id),
      senderNumber,
      webhookPublicKeyConfigured: provider === "telnyx"
        ? (hosted ? Boolean(getEnv().HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY) : Boolean(settings.webhookPublicKey || legacy.webhookPublicKey))
        : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(updateSchema, await request.json());
    const integration = await getPrivateIntegration(context.workspace.id, input.provider);
    if (!integration || integration.status !== "CONNECTED") {
      throw new AppError("SMS_INTEGRATION_NOT_CONNECTED", "The SMS integration must be connected before updating webhook settings.", 409);
    }
    if (input.webhookPublicKey !== undefined && input.provider !== "telnyx") {
      throw new AppError("BAD_REQUEST", "Only Telnyx uses a configured Ed25519 webhook public key.", 400);
    }

    const legacy = legacyPublicSettings(integration.encryptedCredentials);
    const settings = {
      ...integration.settings,
      ...(input.phone !== undefined ? { phone: normalizePhone(input.phone) } : {}),
      ...(input.webhookPublicKey !== undefined ? { webhookPublicKey: input.webhookPublicKey } : {}),
    };
    const updated = await saveIntegration(context.workspace.id, {
      provider: input.provider,
      category: "COMMUNICATION",
      mode: "BYOP",
      credentials: {},
      settings,
    });
    return Response.json({
      integration: updated,
      webhookUrl: callbackUrl(input.provider, context.workspace.id),
      senderNumber: typeof settings.phone === "string" ? settings.phone : legacy.phone ?? null,
      webhookPublicKeyConfigured: input.provider === "telnyx" ? Boolean(settings.webhookPublicKey || legacy.webhookPublicKey) : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

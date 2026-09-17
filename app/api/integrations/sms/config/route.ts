import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getPrivateIntegration, saveIntegration } from "@/server/domain/integrations/repository";
import { normalizePhone } from "@/server/domain/core/schemas";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { resolveProviderRoute } from "@/server/providers/resolver";

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

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const route = await resolveProviderRoute(context.workspace.id, "SMS");
    if (!route) return Response.json({ configured: false, mode: null, provider: null, webhookUrl: null });

    const provider = route.mode === "HOSTED" ? getEnv().HOSTED_SMS_PROVIDER : providerSchema.parse(route.provider);
    return Response.json({
      configured: true,
      mode: route.mode,
      provider,
      webhookUrl: callbackUrl(provider, context.workspace.id),
      senderNumber: typeof route.settings.phone === "string" ? route.settings.phone : null,
      webhookPublicKeyConfigured: provider === "telnyx"
        ? (route.mode === "HOSTED" ? Boolean(getEnv().HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY) : Boolean(route.settings.webhookPublicKey))
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
    const route = await resolveProviderRoute(context.workspace.id, "SMS");
    if (!route || route.mode !== "BYOP" || route.provider !== input.provider) {
      throw new AppError("SMS_ROUTE_MISMATCH", "Configure the active BYOP SMS provider before updating webhook settings.", 409);
    }
    const integration = await getPrivateIntegration(context.workspace.id, input.provider);
    if (!integration || integration.id !== route.integrationId || integration.status !== "CONNECTED") {
      throw new AppError("SMS_INTEGRATION_NOT_CONNECTED", "The active SMS integration is not connected.", 409);
    }
    if (input.webhookPublicKey !== undefined && input.provider !== "telnyx") {
      throw new AppError("BAD_REQUEST", "Only Telnyx uses a configured Ed25519 webhook public key.", 400);
    }

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
      senderNumber: settings.phone ?? null,
      webhookPublicKeyConfigured: input.provider === "telnyx" ? Boolean(settings.webhookPublicKey) : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

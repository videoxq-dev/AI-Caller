import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { listIntegrations, saveIntegration, setIntegrationStatus, testSavedIntegration } from "@/server/domain/integrations/repository";
import { integrationSaveSchema, providerIdSchema } from "@/server/domain/integrations/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { z } from "zod";

const disconnectSchema = z.object({
  provider: providerIdSchema,
  status: z.literal("DISCONNECTED"),
});

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
    const integration = await saveIntegration(context.workspace.id, input);
    if (input.provider === "credits") return Response.json({ integration, test: { ok: true } });
    const test = await testSavedIntegration(context.workspace.id, input.provider);
    return Response.json({ integration: test.integration, test: { ok: test.ok, error: test.ok ? null : test.error } });
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

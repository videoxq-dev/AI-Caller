import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { listIntegrations, saveIntegration, setIntegrationStatus } from "@/server/domain/integrations/repository";
import { integrationSaveSchema, providerIdSchema } from "@/server/domain/integrations/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { z } from "zod";

const statusInputSchema = z.object({
  provider: providerIdSchema,
  status: z.enum(["CONNECTED", "ERROR", "DISCONNECTED"]),
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
    return Response.json({ integration: await saveIntegration(context.workspace.id, input) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(statusInputSchema, await request.json());
    return Response.json({ integration: await setIntegrationStatus(context.workspace.id, input.provider, input.status) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

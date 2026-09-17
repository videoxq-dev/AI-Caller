import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getCommunicationSetup, saveCommunicationSetup } from "@/server/domain/integrations/repository";
import { communicationSetupSchema } from "@/server/domain/integrations/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json({ settings: await getCommunicationSetup(context.workspace.id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(communicationSetupSchema, await request.json());
    return Response.json({ settings: await saveCommunicationSetup(context.workspace.id, input) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

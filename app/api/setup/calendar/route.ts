import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getCalendarSetup, saveCalendarSetup } from "@/server/domain/integrations/repository";
import { calendarSetupSchema } from "@/server/domain/integrations/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json({ settings: await getCalendarSetup(context.workspace.id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(calendarSetupSchema, await request.json());
    return Response.json({ settings: await saveCalendarSetup(context.workspace.id, input) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

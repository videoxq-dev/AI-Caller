import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { getBusinessSetup, saveBusinessGeneralSettings, saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { businessProfileInputSchema } from "@/server/domain/onboarding/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json(await getBusinessSetup(context.workspace.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(businessProfileInputSchema, await request.json());
    const profile = await saveBusinessSetup(context.workspace.id, input);
    return Response.json({ profile });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(businessProfileInputSchema.pick({ businessName: true, timezone: true }).strict(), await request.json());
    const profile = await saveBusinessGeneralSettings(context.workspace.id, input);
    return Response.json({ profile });
  } catch (error) {
    return toErrorResponse(error);
  }
}

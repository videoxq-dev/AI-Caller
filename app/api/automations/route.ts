import { z } from "zod";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { listAutomationSettings } from "@/server/automations/repository";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const settings = await listAutomationSettings(context.workspace.id);
    return Response.json({
      settings,
      canManage: context.membership.role === "OWNER" || context.membership.role === "ADMIN",
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

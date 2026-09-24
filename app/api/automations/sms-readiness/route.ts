import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { smsAutomationReadiness } from "@/server/sms/automation-readiness";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const readiness = await smsAutomationReadiness(context.workspace.id);
    return Response.json({ readiness }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { refreshManagedVoiceWebhook } from "@/server/phone-numbers/service";
import { toErrorResponse } from "@/server/http/errors";

// Explicit owner action: update one existing Telnyx Call Control callback.
// Never create a number or alter an SMS registration from this route.
export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const result = await refreshManagedVoiceWebhook(context.workspace.id);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

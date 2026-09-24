import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { ProviderRequestError } from "@/server/providers/http";
import { templateCursorSchema } from "@/server/providers/whatsapp/meta-templates";
import { resolveWhatsAppTemplatesForWorkspace } from "@/server/providers/whatsapp/runtime";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "automation.manage");
    const cursor = new URL(request.url).searchParams.get("after");
    const after = cursor === null ? undefined : parseInput(templateCursorSchema, cursor);
    const client = await resolveWhatsAppTemplatesForWorkspace(context.workspace.id);
    const page = await client.list(after);
    return Response.json({
      items: page.items.filter(item => item.status === "APPROVED"
        && (item.category === "UTILITY" || item.category === "MARKETING") && item.body),
      nextCursor: page.nextCursor,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return toErrorResponse(new AppError("WHATSAPP_TEMPLATES_UNAVAILABLE",
        "Meta could not verify your approved WhatsApp templates. Try again.", 502));
    }
    return toErrorResponse(error);
  }
}

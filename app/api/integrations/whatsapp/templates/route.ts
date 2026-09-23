import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { ProviderRequestError } from "@/server/providers/http";
import { createWhatsAppTemplateSchema, templateCursorSchema } from "@/server/providers/whatsapp/meta-templates";
import { resolveWhatsAppTemplatesForWorkspace } from "@/server/providers/whatsapp/runtime";

function publicError(error: unknown) {
  if (error instanceof ProviderRequestError) {
    return new AppError("META_TEMPLATE_REQUEST_FAILED", error.status === 403
      ? "Meta denied template access. Check WhatsApp Business Management permissions for this account."
      : "Meta could not complete the template request. Check the WhatsApp connection and try again.", 502);
  }
  return error;
}

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const rawCursor = new URL(request.url).searchParams.get("after");
    const after = rawCursor === null ? undefined : parseInput(templateCursorSchema, rawCursor);
    const client = await resolveWhatsAppTemplatesForWorkspace(context.workspace.id);
    const page = await client.list(after);
    return Response.json(page, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(publicError(error));
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(createWhatsAppTemplateSchema, await request.json());
    const client = await resolveWhatsAppTemplatesForWorkspace(context.workspace.id);
    const submitted = await client.submit(input);
    return Response.json({ template: submitted }, { status: 201 });
  } catch (error) {
    return toErrorResponse(publicError(error));
  }
}

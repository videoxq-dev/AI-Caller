import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { updateWebchatWidgetById } from "@/server/webchat/repository";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  greeting: z.string().trim().max(500).nullable().optional(),
  launcherLabel: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
}).refine((input) => Object.keys(input).length > 0, {
  message: "Provide at least one widget setting to update.",
});

function widgetResponse(widget: Awaited<ReturnType<typeof updateWebchatWidgetById>>) {
  const origin = getEnv().BETTER_AUTH_URL.replace(/\/$/, "");
  return {
    id: widget.id,
    publicKey: widget.publicKey,
    name: widget.name,
    isPrimary: widget.isPrimary,
    enabled: widget.enabled,
    greeting: widget.greeting,
    launcherLabel: widget.launcherLabel,
    embedCode: `<script async src="${origin}/widget/loader" data-ai-caller-key="${widget.publicKey}"></script>`,
    createdAt: widget.createdAt,
    updatedAt: widget.updatedAt,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) {
      throw new AppError("BAD_REQUEST", "Invalid widget id.", 400);
    }
    const input = parseInput(updateSchema, await request.json());
    const widget = await updateWebchatWidgetById(context.workspace.id, id, input);
    return Response.json({ widget: widgetResponse(widget) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

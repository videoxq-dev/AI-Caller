import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { ensureWebchatWidget, getPublicWebchatWidget, updateWebchatWidget } from "@/server/webchat/repository";

const updateSchema = z.object({
  greeting: z.string().trim().max(500).nullable().optional(),
  launcherLabel: z.string().trim().min(1).max(80).optional(),
});

function responseFor(request: Request, widget: Awaited<ReturnType<typeof ensureWebchatWidget>>, greeting: string | null) {
  const origin = new URL(request.url).origin;
  return {
    publicKey: widget.publicKey,
    enabled: widget.enabled,
    greeting,
    launcherLabel: widget.launcherLabel,
    embedCode: `<script async src="${origin}/widget/loader" data-ai-caller-key="${widget.publicKey}"></script>`,
  };
}

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const widget = await ensureWebchatWidget(context.workspace.id);
    const publicConfig = await getPublicWebchatWidget(widget.publicKey);
    return Response.json(responseFor(request, widget, publicConfig?.greeting ?? null));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(updateSchema, await request.json());
    const widget = await updateWebchatWidget(context.workspace.id, input);
    const publicConfig = await getPublicWebchatWidget(widget.publicKey);
    return Response.json(responseFor(request, widget, publicConfig?.greeting ?? null));
  } catch (error) {
    return toErrorResponse(error);
  }
}

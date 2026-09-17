import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { ensureWebchatWidget, getPublicWebchatWidget } from "@/server/webchat/repository";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const widget = await ensureWebchatWidget(context.workspace.id);
    const publicConfig = await getPublicWebchatWidget(widget.publicKey);
    const origin = new URL(request.url).origin;
    return Response.json({
      publicKey: widget.publicKey,
      enabled: widget.enabled,
      greeting: publicConfig?.greeting ?? null,
      launcherLabel: publicConfig?.launcherLabel ?? widget.launcherLabel,
      embedCode: `<script async src="${origin}/widget/loader" data-ai-caller-key="${widget.publicKey}"></script>`,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

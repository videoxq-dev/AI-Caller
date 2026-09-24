import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { getWorkspaceIntegrationEntitlements } from "@/server/commerce/workspace-entitlements";
import { getEnv } from "@/server/env";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { createAdditionalWebchatWidget, listWebchatWidgets } from "@/server/webchat/repository";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  greeting: z.string().trim().max(500).nullable().optional(),
  launcherLabel: z.string().trim().min(1).max(80).optional(),
});

function widgetResponse(widget: Awaited<ReturnType<typeof listWebchatWidgets>>[number]) {
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

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const [widgets, entitlements] = await Promise.all([
      listWebchatWidgets(context.workspace.id),
      getWorkspaceIntegrationEntitlements(context.workspace.id),
    ]);
    return Response.json({
      widgets: widgets.map(widgetResponse),
      entitlements: { unlimitedWidgets: entitlements.unlimited },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(createSchema, await request.json());
    const widget = await createAdditionalWebchatWidget(context.workspace.id, input);
    return Response.json({ widget: widgetResponse(widget) }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

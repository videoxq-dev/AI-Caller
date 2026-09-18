import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { listNotifications } from "@/server/collaboration/service";
import { toErrorResponse } from "@/server/http/errors";

const querySchema = z.coerce.number().int().min(1).max(100).default(50);

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const url = new URL(request.url);
    const limit = querySchema.parse(url.searchParams.get("limit") ?? "50");
    const items = await listNotifications(context.workspace.id, context.session.user.id, limit);
    return Response.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

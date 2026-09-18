import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { markNotificationRead } from "@/server/collaboration/service";
import { toErrorResponse } from "@/server/http/errors";

const idSchema = z.string().uuid();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const notification = await markNotificationRead(context.workspace.id, context.session.user.id, idSchema.parse(id));
    return Response.json({ notification });
  } catch (error) {
    return toErrorResponse(error);
  }
}

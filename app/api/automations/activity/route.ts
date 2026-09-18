import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { listAutomationActivity } from "@/server/automations/repository";
import { toErrorResponse } from "@/server/http/errors";

const limitSchema = z.coerce.number().int().min(1).max(100).default(50);

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const url = new URL(request.url);
    const limit = limitSchema.parse(url.searchParams.get("limit") ?? "50");
    const items = await listAutomationActivity(context.workspace.id, limit);
    return Response.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

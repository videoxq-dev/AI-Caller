import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { buildAgencyTemplatePreview } from "@/server/agency/templates";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const url = new URL(request.url);
    const sourceWorkspaceId = z.string().uuid().parse(url.searchParams.get("sourceWorkspaceId"));
    const preview = await buildAgencyTemplatePreview(session.user.id, sourceWorkspaceId);
    return Response.json(preview, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

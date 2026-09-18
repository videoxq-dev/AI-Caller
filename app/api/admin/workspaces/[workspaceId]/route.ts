import { z } from "zod";
import { requirePlatformAdmin } from "@/server/admin/auth";
import { updateAdminWorkspace } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const updateSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  planId: z.enum(["PERSONAL", "GROWTH"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one workspace field must be changed.");

export async function PATCH(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const { workspaceId } = await params;
    const input = parseInput(updateSchema, await request.json());
    await updateAdminWorkspace({
      actorUserId: admin.session.user.id,
      workspaceId,
      ...input,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

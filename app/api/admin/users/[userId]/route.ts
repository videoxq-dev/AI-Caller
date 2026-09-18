import { z } from "zod";
import { requirePlatformAdmin } from "@/server/admin/auth";
import { deleteAdminUser, updateAdminUser } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  suspensionReason: z.string().trim().max(500).nullable().optional(),
  platformAdmin: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one user field must be changed.");

const deleteSchema = z.object({
  deleteOwnedWorkspaces: z.boolean().default(false),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const { userId } = await params;
    const input = parseInput(updateSchema, await request.json());
    const user = await updateAdminUser({
      actorUserId: admin.session.user.id,
      userId,
      ...input,
    });
    return Response.json({ user });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const { userId } = await params;
    const body = await request.json().catch(() => ({}));
    const input = parseInput(deleteSchema, body);
    const result = await deleteAdminUser({
      actorUserId: admin.session.user.id,
      userId,
      deleteOwnedWorkspaces: input.deleteOwnedWorkspaces,
    });
    return Response.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { z } from "zod";
import { requirePlatformAdmin } from "@/server/admin/auth";
import { updateAdminPlan } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const schema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
  subUserLimit: z.number().int().min(0).max(100).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one plan field must be changed.");

export async function PATCH(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const { planId } = await params;
    if (planId !== "PERSONAL" && planId !== "GROWTH") {
      return Response.json({ error: { code: "PLAN_NOT_FOUND", message: "Plan not found." } }, { status: 404 });
    }
    const input = parseInput(schema, await request.json());
    const plan = await updateAdminPlan({
      actorUserId: admin.session.user.id,
      planId,
      ...input,
    });
    return Response.json({ plan });
  } catch (error) {
    return toErrorResponse(error);
  }
}

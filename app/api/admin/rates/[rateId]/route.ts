import { z } from "zod";
import { requirePlatformAdmin } from "@/server/admin/auth";
import { setAdminRateEnabled } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const schema = z.object({ enabled: z.boolean() });

export async function PATCH(request: Request, { params }: { params: Promise<{ rateId: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const { rateId } = await params;
    const input = parseInput(schema, await request.json());
    const rate = await setAdminRateEnabled({
      actorUserId: admin.session.user.id,
      rateId,
      enabled: input.enabled,
    });
    return Response.json({ rate });
  } catch (error) {
    return toErrorResponse(error);
  }
}

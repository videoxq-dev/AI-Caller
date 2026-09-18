import { z } from "zod";
import { requirePlatformAdmin } from "@/server/admin/auth";
import { adjustWorkspaceCredits } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const schema = z.object({
  amount: z.number().int().min(-10_000_000).max(10_000_000).refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(500),
});

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const { workspaceId } = await params;
    const input = parseInput(schema, await request.json());
    return Response.json(await adjustWorkspaceCredits({
      actorUserId: admin.session.user.id,
      workspaceId,
      amount: input.amount,
      reason: input.reason,
    }));
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { allocateAgencyCredits } from "@/server/agency/credit-pool";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({
  workspaceId: z.string().uuid(),
  amount: z.number().int().positive().max(1_000_000_000),
  idempotencyKey: z.string().uuid(),
});

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const input = parseInput(inputSchema, await request.json());
    const allocation = await allocateAgencyCredits({
      purchaserUserId: session.user.id,
      workspaceId: input.workspaceId,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
    });
    return Response.json({ allocation }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

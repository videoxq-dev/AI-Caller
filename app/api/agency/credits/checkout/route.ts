import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { requireAgencyCreditPurchaser } from "@/server/agency/credit-pool";
import { createCreditTopupCheckout } from "@/server/billing/checkout";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({ packCode: z.string().trim().min(1).max(80) });

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const input = parseInput(inputSchema, await request.json());
    const originalWorkspaceId = await requireAgencyCreditPurchaser(session.user.id);
    const result = await createCreditTopupCheckout({
      workspaceId: originalWorkspaceId,
      userId: session.user.id,
      customerEmail: session.user.email,
      packCode: input.packCode,
      appBaseUrl: getEnv().BETTER_AUTH_URL,
      fundingDestination: "AGENCY_POOL",
      agencyPurchaserUserId: session.user.id,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

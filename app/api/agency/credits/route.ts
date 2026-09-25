import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getAgencyCreditOverview } from "@/server/agency/credit-pool";
import { listActiveCreditPacks } from "@/server/billing/checkout";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const [overview, packs] = await Promise.all([
      getAgencyCreditOverview(session.user.id),
      listActiveCreditPacks(),
    ]);
    return Response.json({ ...overview, packs }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

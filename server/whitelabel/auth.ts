import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { requireEffectiveWhitelabelPurchaser } from "@/server/auth/commercial-ownership";
import { AppError } from "@/server/http/errors";

export async function requireWhitelabelAdmin(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
  await assertPlatformUserActive(session.user.id);
  const entitlement = await requireEffectiveWhitelabelPurchaser(session.user.id);
  return { session, ...entitlement };
}

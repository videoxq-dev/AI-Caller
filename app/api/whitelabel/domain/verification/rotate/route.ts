import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import { rotateWhitelabelDomainVerification } from "@/server/whitelabel/domain-service";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const domain = await rotateWhitelabelDomainVerification(context.session.user.id);
    return Response.json({ domain }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

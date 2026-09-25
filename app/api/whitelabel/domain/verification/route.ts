import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import { getWhitelabelDomainState } from "@/server/whitelabel/domain-service";
import { enqueueUniqueJob } from "@/server/jobs";
import { WHITELABEL_DOMAIN_RECONCILE } from "@/server/jobs/queues";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function POST(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const domain = await getWhitelabelDomainState(context.session.user.id);
    if (!domain) throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "No custom domain is connected.", 404);
    if (["DISABLED", "DISABLING", "REVOKED"].includes(domain.status)) {
      throw new AppError("WHITELABEL_DOMAIN_NOT_VERIFIABLE", "This custom domain is not available for verification.", 409);
    }
    await enqueueUniqueJob(WHITELABEL_DOMAIN_RECONCILE, domain.id, { domainId: domain.id });
    return Response.json({ domain, queued: true }, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

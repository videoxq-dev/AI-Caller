import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import {
  claimWhitelabelDomain,
  disconnectWhitelabelDomain,
  getWhitelabelDomainState,
} from "@/server/whitelabel/domain-service";
import { claimWhitelabelDomainSchema } from "@/server/whitelabel/domain-schema";
import { parseInput } from "@/server/http/validation";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    return Response.json({
      domain: await getWhitelabelDomainState(context.session.user.id),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const input = parseInput(claimWhitelabelDomainSchema, await request.json());
    const domain = await claimWhitelabelDomain(context.session.user.id, input.hostname);
    return Response.json({ domain }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const domain = await disconnectWhitelabelDomain(context.session.user.id);
    return Response.json({ domain }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

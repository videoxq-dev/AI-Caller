import { getBrandState, saveBrandDraft } from "@/server/whitelabel/brand-service";
import { saveBrandDraftSchema } from "@/server/whitelabel/brand-schema";
import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import { parseInput } from "@/server/http/validation";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    return Response.json(await getBrandState(context.session.user.id), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const input = parseInput(saveBrandDraftSchema, await request.json());
    return Response.json(await saveBrandDraft(
      context.session.user.id,
      input.expectedRevision,
      input.brand,
    ), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

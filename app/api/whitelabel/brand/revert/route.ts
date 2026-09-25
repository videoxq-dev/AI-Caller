import { revertPublishedBrand } from "@/server/whitelabel/brand-service";
import { revertBrandRequestSchema } from "@/server/whitelabel/brand-schema";
import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import { parseInput } from "@/server/http/validation";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const input = parseInput(revertBrandRequestSchema, await request.json());
    return Response.json(await revertPublishedBrand(context.session.user.id, input.version), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

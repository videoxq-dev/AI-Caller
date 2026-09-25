import { publishBrand } from "@/server/whitelabel/brand-service";
import { publishBrandRequestSchema } from "@/server/whitelabel/brand-schema";
import { requireWhitelabelAdmin } from "@/server/whitelabel/auth";
import { parseInput } from "@/server/http/validation";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(request: Request) {
  try {
    const context = await requireWhitelabelAdmin(request.headers);
    const input = parseInput(publishBrandRequestSchema, await request.json());
    return Response.json(await publishBrand(context.session.user.id, input.expectedRevision), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

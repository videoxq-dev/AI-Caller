import { requirePlatformAdmin } from "@/server/admin/auth";
import { readPlatformReadiness } from "@/server/admin/readiness";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request.headers);
    return Response.json({ items: readPlatformReadiness() });
  } catch (error) {
    return toErrorResponse(error);
  }
}

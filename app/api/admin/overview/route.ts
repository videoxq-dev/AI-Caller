import { requirePlatformAdmin } from "@/server/admin/auth";
import { getAdminOverview } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request.headers);
    return Response.json(await getAdminOverview());
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { requirePlatformAdmin } from "@/server/admin/auth";
import { listAdminPlans } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request.headers);
    return Response.json({ items: await listAdminPlans() });
  } catch (error) {
    return toErrorResponse(error);
  }
}

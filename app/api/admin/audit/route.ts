import { requirePlatformAdmin } from "@/server/admin/auth";
import { listAdminAuditLogs } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request.headers);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    return Response.json({ items: await listAdminAuditLogs(limit) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

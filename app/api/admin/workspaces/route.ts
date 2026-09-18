import { requirePlatformAdmin } from "@/server/admin/auth";
import { listAdminWorkspaces } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request.headers);
    const url = new URL(request.url);
    return Response.json(await listAdminWorkspaces({
      limit: Number(url.searchParams.get("limit") ?? "50"),
      offset: Number(url.searchParams.get("offset") ?? "0"),
      search: url.searchParams.get("search") ?? undefined,
    }));
  } catch (error) {
    return toErrorResponse(error);
  }
}

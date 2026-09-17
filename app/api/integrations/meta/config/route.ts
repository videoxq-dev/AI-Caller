import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getMetaPublicConfig } from "@/server/providers/meta";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request) {
  try {
    await resolveWorkspaceContext(request.headers);
    return Response.json(getMetaPublicConfig());
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { activateManualCoreLicense } from "@/server/commerce/service";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function POST(request: Request) {
  try {
    if (getEnv().NODE_ENV === "production") throw new AppError("NOT_FOUND", "Not found.", 404);
    const context = await resolveWorkspaceContext(request.headers);
    const result = await activateManualCoreLicense(context.workspace.id);
    return Response.json({ ok: true, balance: result.balance, licenseId: result.license.id });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { headers } from "next/headers";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const context = await resolveWorkspaceContext(await headers());
    return Response.json({
      data: {
        user: {
          id: context.session.user.id,
          name: context.session.user.name,
          email: context.session.user.email,
        },
        workspace: context.workspace,
        role: context.membership.role,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

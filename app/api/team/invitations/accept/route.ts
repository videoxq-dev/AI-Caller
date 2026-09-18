import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { activeWorkspaceCookie } from "@/server/auth/active-workspace";
import { acceptWorkspaceInvitation } from "@/server/auth/team-repository";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({ token: z.string().min(20).max(200) });

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "Sign in to accept this invitation.", 401);
    await assertPlatformUserActive(session.user.id);
    const input = parseInput(inputSchema, await request.json());
    const accepted = await acceptWorkspaceInvitation({
      userId: session.user.id,
      userEmail: session.user.email,
      token: input.token,
    });

    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", activeWorkspaceCookie(accepted.workspaceId, getEnv().NODE_ENV === "production"));
    return new Response(JSON.stringify({ membership: accepted }), { status: 200, headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

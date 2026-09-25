import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { activeWorkspaceCookie } from "@/server/auth/active-workspace";
import { createWorkspaceFromAgencyTemplate } from "@/server/agency/template-cloning";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  templateId: z.string().uuid(),
  version: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
}).strict();

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const input = parseInput(inputSchema, await request.json());
    const workspace = await createWorkspaceFromAgencyTemplate({
      purchaserUserId: session.user.id,
      ...input,
    });
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    headers.append("set-cookie", activeWorkspaceCookie(
      workspace.workspaceId, getEnv().NODE_ENV === "production",
    ));
    return new Response(JSON.stringify({ workspace }), { status: 201, headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

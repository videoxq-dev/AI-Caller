import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { activeWorkspaceCookie } from "@/server/auth/active-workspace";
import { createWorkspaceForUser, getMembership, listMembershipsForUser } from "@/server/auth/workspace-repository";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({ workspaceId: z.string().uuid() });
const createSchema = z.object({ name: z.string().trim().min(2).max(120) });

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const memberships = await listMembershipsForUser(context.session.user.id);
    return Response.json({ workspaces: memberships, activeWorkspaceId: context.workspace.id });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const input = parseInput(inputSchema, await request.json());
    const membership = await getMembership(session.user.id, input.workspaceId);
    if (!membership) throw new AppError("WORKSPACE_NOT_FOUND", "You are not a member of that workspace.", 404);
    if (membership.workspaceStatus === "SUSPENDED") throw new AppError("WORKSPACE_SUSPENDED", "This workspace is suspended.", 403);
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", activeWorkspaceCookie(membership.workspaceId, getEnv().NODE_ENV === "production"));
    return new Response(JSON.stringify({ workspace: membership }), { status: 200, headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const input = parseInput(createSchema, await request.json());
    const workspace = await createWorkspaceForUser(session.user.id, input.name);
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", activeWorkspaceCookie(workspace.workspaceId, getEnv().NODE_ENV === "production"));
    return new Response(JSON.stringify({ workspace }), { status: 201, headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

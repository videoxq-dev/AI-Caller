import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { createAgencyTemplate, listAgencyTemplates } from "@/server/agency/templates";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const createInput = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(400).nullable().optional(),
  reviewed: z.literal(true),
  snapshot: z.unknown(),
}).strict();

async function authenticatedAgencyUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
  await assertPlatformUserActive(session.user.id);
  return session.user;
}

export async function GET(request: Request) {
  try {
    const user = await authenticatedAgencyUser(request);
    return Response.json({ templates: await listAgencyTemplates(user.id) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await authenticatedAgencyUser(request);
    const input = parseInput(createInput, await request.json());
    const template = await createAgencyTemplate({ purchaserUserId: user.id, ...input });
    return Response.json({ template }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

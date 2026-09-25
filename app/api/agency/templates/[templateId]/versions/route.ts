import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { publishAgencyTemplateVersion } from "@/server/agency/templates";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const idSchema = z.string().uuid();
const inputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(400).nullable().optional(),
  reviewed: z.literal(true),
  snapshot: z.unknown(),
}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ templateId: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
    await assertPlatformUserActive(session.user.id);
    const templateId = idSchema.parse((await params).templateId);
    const input = parseInput(inputSchema, await request.json());
    const template = await publishAgencyTemplateVersion({
      purchaserUserId: session.user.id, templateId, ...input,
    });
    return Response.json({ template }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

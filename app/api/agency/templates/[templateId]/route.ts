import { z } from "zod";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { archiveAgencyTemplate, getAgencyTemplateVersion } from "@/server/agency/templates";
import { AppError, toErrorResponse } from "@/server/http/errors";

const idSchema = z.string().uuid();

async function currentUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
  await assertPlatformUserActive(session.user.id);
  return session.user.id;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ templateId: string }> },
) {
  try {
    const userId = await currentUser(request);
    const templateId = idSchema.parse((await params).templateId);
    const requested = new URL(request.url).searchParams.get("version");
    const version = requested === null
      ? undefined : z.coerce.number().int().positive().parse(requested);
    return Response.json({ template: await getAgencyTemplateVersion(userId, templateId, version) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ templateId: string }> },
) {
  try {
    const userId = await currentUser(request);
    const templateId = idSchema.parse((await params).templateId);
    return Response.json({ template: await archiveAgencyTemplate(userId, templateId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

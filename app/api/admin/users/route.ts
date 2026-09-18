import { z } from "zod";
import { requirePlatformAdmin } from "@/server/admin/auth";
import { createAdminUser, listAdminUsers } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
});

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request.headers);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const search = url.searchParams.get("search") ?? undefined;
    return Response.json(await listAdminUsers({ limit, offset, search }));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const input = parseInput(createSchema, await request.json());
    const created = await createAdminUser({
      actorUserId: admin.session.user.id,
      name: input.name,
      email: input.email,
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

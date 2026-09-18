import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { toErrorResponse } from "@/server/http/errors";
import { searchManagedPhoneNumbers } from "@/server/phone-numbers/service";

const querySchema = z.object({
  country: z.string().trim().default("US"),
  state: z.string().trim().max(3).optional(),
  city: z.string().trim().max(120).optional(),
  areaCode: z.string().trim().max(8).optional(),
  type: z.enum(["local", "toll_free"]).default("local"),
});

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const url = new URL(request.url);
    const parsed = querySchema.parse({
      country: url.searchParams.get("country") ?? "US",
      state: url.searchParams.get("state") || undefined,
      city: url.searchParams.get("city") || undefined,
      areaCode: url.searchParams.get("areaCode") || undefined,
      type: url.searchParams.get("type") ?? "local",
    });
    const items = await searchManagedPhoneNumbers({
      countryCode: parsed.country,
      administrativeArea: parsed.state,
      locality: parsed.city,
      areaCode: parsed.areaCode,
      numberType: parsed.type,
    });
    return Response.json({ items }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

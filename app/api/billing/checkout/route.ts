import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { createCreditTopupCheckout } from "@/server/billing/checkout";
import { getEnv } from "@/server/env";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({
  packCode: z.string().trim().min(1).max(80),
});

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const input = parseInput(inputSchema, await request.json());
    const checkout = await createCreditTopupCheckout({
      workspaceId: context.workspace.id,
      userId: context.session.user.id,
      customerEmail: context.session.user.email,
      packCode: input.packCode,
      appBaseUrl: getEnv().BETTER_AUTH_URL,
    });
    return Response.json(checkout, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { bindCapability, saveVerifiedIntegration } from "@/server/domain/integrations/repository";
import { completeMetaEmbeddedSignup } from "@/server/providers/meta";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const inputSchema = z.object({
  code: z.string().min(1),
  wabaId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  businessId: z.string().min(1).nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(inputSchema, await request.json());
    const result = await completeMetaEmbeddedSignup(input);
    const integration = await saveVerifiedIntegration(context.workspace.id, {
      provider: "whatsapp",
      category: "WHATSAPP",
      mode: "BYOP",
      credentials: result.credentials,
      settings: result.settings,
    });
    await bindCapability(context.workspace.id, "WHATSAPP", "BYOP", "whatsapp");
    return Response.json({ integration });
  } catch (error) {
    return toErrorResponse(error);
  }
}

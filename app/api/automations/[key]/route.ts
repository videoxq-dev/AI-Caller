import { z } from "zod";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { saveAutomationSetting } from "@/server/automations/repository";
import { automationKeys, type AutomationKey } from "@/server/automations/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const keySchema = z.enum(automationKeys);
const inputSchema = z.object({
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "automation.manage");
    const { key: rawKey } = await params;
    const key = keySchema.parse(rawKey) as AutomationKey;
    const input = parseInput(inputSchema, await request.json());
    const setting = await saveAutomationSetting(context.workspace.id, key, input);
    return Response.json({ setting });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { z } from "zod";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { builderStarter } from "@/server/automations/builder-catalog";
import { listBuilderWorkflows } from "@/server/automations/builder-service";
import { createWorkflowDraft } from "@/server/automations/workflows";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const createSchema = z.object({
  starter: z.enum([
    "HIGH_VALUE_LEAD_ALERT",
    "NEW_APPOINTMENT_ALERT",
    "CUSTOMER_BOOKING_CONFIRMATION",
    "BLANK",
  ]).default("BLANK"),
}).strict();

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const items = await listBuilderWorkflows(context.workspace.id);
    return Response.json({
      items,
      canManage: context.membership.role === "OWNER" || context.membership.role === "ADMIN",
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "automation.manage");
    const input = parseInput(createSchema, await request.json());
    const starter = builderStarter(input.starter);
    const definition = await createWorkflowDraft(
      context.workspace.id,
      starter.name,
      starter.definition,
    );
    return Response.json({ id: definition.id }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

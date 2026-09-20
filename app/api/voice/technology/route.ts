import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { hasWorkspacePermission, requireWorkspacePermission } from "@/server/auth/permissions";
import { getVoiceTechnology, hasRealtimeGatewayConfiguration, setVoiceTechnology } from "@/server/voice/technology";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const schema = z.object({
  technology: z.enum(["STANDARD", "REALTIME"]),
  realtimeModel: z.enum(["gpt-realtime-2.1", "gpt-realtime-2.1-mini"]),
}).strict();

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    return Response.json({
      ...await getVoiceTechnology(context.workspace.id),
      realtimeConfigured: hasRealtimeGatewayConfiguration(),
      canManage: hasWorkspacePermission(context.membership.role, "billing.manage"),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const input = parseInput(schema, await request.json());
    const saved = await setVoiceTechnology(context.workspace.id, input);
    return Response.json(saved, { headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

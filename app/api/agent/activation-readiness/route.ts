import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import {
  confirmTemplateClientManualReview, getTemplateClientActivationReadiness,
} from "@/server/agent/template-activation-readiness";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const reviewSchema = z.object({ reviewed: z.literal(true) }).strict();

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const readiness = await getTemplateClientActivationReadiness(context.workspace.id);
    return Response.json({ readiness }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    parseInput(reviewSchema, await request.json());
    const readiness = await confirmTemplateClientManualReview(
      context.workspace.id, context.session.user.id,
    );
    return Response.json({ readiness });
  } catch (error) {
    return toErrorResponse(error);
  }
}

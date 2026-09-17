import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { runAgentTest } from "@/server/orchestrator/test-mode";

const testInputSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4000),
  })).max(30).default([]),
});

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(testInputSchema, await request.json());
    const result = await runAgentTest(
      context.workspace.id,
      context.session.user.id,
      [...input.history, { role: "user" as const, content: input.message }],
    );
    const simulated = "simulated" in result.toolResult.data && result.toolResult.data.simulated === true;

    return Response.json({
      reply: result.reply,
      handlingMode: result.handlingMode,
      action: result.action.type,
      toolResult: result.toolResult,
      simulated,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

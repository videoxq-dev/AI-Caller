import { appendMessage } from "@/server/domain/core/repository";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { responseOrchestrator } from "@/server/orchestrator";
import {
  claimWebchatTurn,
  completeWebchatTurn,
  failWebchatTurn,
  findWebchatAIResponse,
  resolveWebchatSession,
} from "@/server/webchat/repository";
import { webchatMessageInputSchema } from "@/server/webchat/schemas";

const encoder = new TextEncoder();

function bearerToken(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7).trim();
  return token || null;
}

function event(name: string, data: unknown) {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function enqueueReply(controller: ReadableStreamDefaultController<Uint8Array>, reply: string) {
  for (let index = 0; index < reply.length; index += 120) {
    controller.enqueue(event("message", { delta: reply.slice(index, index + 120) }));
  }
}

export async function POST(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) throw new AppError("WEBCHAT_UNAUTHORIZED", "A valid web chat session is required.", 401);
    const resolved = await resolveWebchatSession(token);
    if (!resolved) throw new AppError("WEBCHAT_SESSION_EXPIRED", "The web chat session is invalid or expired.", 401);

    const body = await request.json();
    const input = parseInput(webchatMessageInputSchema, body);
    const claim = await claimWebchatTurn(resolved.session.workspaceId, resolved.session.id, input.clientMessageId);
    if (claim.state === "in_progress") {
      throw new AppError("WEBCHAT_TURN_IN_PROGRESS", "This message is already being processed.", 409);
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(event("status", { state: claim.state === "completed" ? "cached" : "thinking" }));

          if (claim.state === "completed") {
            if (claim.responseText) enqueueReply(controller, claim.responseText);
            controller.enqueue(event("done", { cached: true }));
            controller.close();
            return;
          }

          const externalBase = `${resolved.session.id}:${input.clientMessageId}`;
          await appendMessage(resolved.session.workspaceId, resolved.session.conversationId, {
            channel: "WEBCHAT",
            direction: "INBOUND",
            senderType: "CUSTOMER",
            contentType: "TEXT",
            body: input.message,
            provider: "webchat-customer",
            externalMessageId: externalBase,
            status: "RECEIVED",
            metadata: { sessionId: resolved.session.id, clientMessageId: input.clientMessageId },
          });

          const existingReply = await findWebchatAIResponse(resolved.session.workspaceId, `${externalBase}:reply`);
          if (existingReply) {
            await completeWebchatTurn(claim.turnId, existingReply.body);
            enqueueReply(controller, existingReply.body);
            controller.enqueue(event("done", { cached: true }));
            controller.close();
            return;
          }

          const result = await responseOrchestrator.respond(resolved.session.workspaceId, resolved.session.conversationId);
          if (!result.reply) {
            await completeWebchatTurn(claim.turnId, null);
            controller.enqueue(event("handoff", { message: "A team member is handling this conversation." }));
            controller.enqueue(event("done", { handlingMode: result.handlingMode }));
            controller.close();
            return;
          }

          const saved = await appendMessage(resolved.session.workspaceId, resolved.session.conversationId, {
            channel: "WEBCHAT",
            direction: "OUTBOUND",
            senderType: "AI",
            contentType: "TEXT",
            body: result.reply,
            provider: "webchat-ai",
            externalMessageId: `${externalBase}:reply`,
            status: "DELIVERED",
            metadata: { action: result.action.type, toolResult: result.toolResult.kind },
          });

          await completeWebchatTurn(claim.turnId, saved.body);
          enqueueReply(controller, saved.body);
          if (result.handlingMode === "HUMAN") {
            controller.enqueue(event("handoff", { message: "A team member will continue from here." }));
          }
          controller.enqueue(event("done", { handlingMode: result.handlingMode }));
          controller.close();
        } catch (error) {
          await failWebchatTurn(claim.turnId, error).catch(() => undefined);
          const message = error instanceof Error ? error.message : "Unable to process this message.";
          controller.enqueue(event("error", { message }));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import {
  appendMessage,
  closeConversation,
  getOrCreateContactByIdentity,
  getOrCreateOpenConversation,
} from "@/server/domain/core/repository";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { agentTestOrchestrator } from "@/server/orchestrator/test-mode";

const testInputSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  clientMessageId: z.string().uuid().optional(),
  reset: z.boolean().default(false),
});

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(testInputSchema, await request.json());
    const externalIdentity = `agent-test:${context.session.user.id}`;
    const contact = await getOrCreateContactByIdentity(context.workspace.id, {
      channel: "WEBCHAT",
      externalId: externalIdentity,
      name: "AI Agent Test",
      email: context.session.user.email,
    });

    let conversation = await getOrCreateOpenConversation(context.workspace.id, contact.id);
    if (input.reset) {
      await closeConversation(context.workspace.id, conversation.id);
      conversation = await getOrCreateOpenConversation(context.workspace.id, contact.id);
    }

    const clientMessageId = input.clientMessageId ?? randomUUID();
    await appendMessage(context.workspace.id, conversation.id, {
      channel: "WEBCHAT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: input.message,
      provider: "agent-test-user",
      externalMessageId: clientMessageId,
      status: "RECEIVED",
      metadata: { testMode: true },
    });

    const result = await agentTestOrchestrator.respond(context.workspace.id, conversation.id);
    if (result.reply) {
      await appendMessage(context.workspace.id, conversation.id, {
        channel: "WEBCHAT",
        direction: "OUTBOUND",
        senderType: "AI",
        contentType: "TEXT",
        body: result.reply,
        provider: "agent-test-ai",
        externalMessageId: `${clientMessageId}:reply`,
        status: "DELIVERED",
        metadata: {
          testMode: true,
          action: result.action.type,
          toolResult: result.toolResult.kind,
          simulated: result.toolResult.data.simulated === true,
        },
      });
    }

    return Response.json({
      conversationId: conversation.id,
      reply: result.reply,
      handlingMode: result.handlingMode,
      action: result.action.type,
      toolResult: result.toolResult,
      simulated: result.toolResult.data.simulated === true,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

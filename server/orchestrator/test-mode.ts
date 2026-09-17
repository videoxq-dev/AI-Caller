import type { AIProvider } from "@/server/providers/contracts";
import { buildConversationContext } from "./context";
import { createResponseOrchestrator } from "./index";
import { executeOrchestratorTools, type OrchestratorEnvelope } from "./tools";
import { generateAIWithUsage } from "./usage";

type AIMessage = Parameters<AIProvider["generate"]>[0]["messages"][number];

async function executeTestTools(
  workspaceId: string,
  conversationId: string,
  contactId: string,
  envelope: OrchestratorEnvelope,
) {
  if (envelope.action.type === "BOOK_APPOINTMENT") {
    return {
      kind: "booking" as const,
      data: {
        simulated: true,
        title: envelope.action.title,
        startsAt: envelope.action.startsAt,
        endsAt: envelope.action.endsAt,
        timezone: envelope.action.timezone,
        status: "SIMULATED",
      },
    };
  }

  if (envelope.action.type === "ESCALATE") {
    return {
      kind: "escalation" as const,
      data: {
        simulated: true,
        handlingMode: "HUMAN",
        reason: envelope.action.reason ?? null,
      },
    };
  }

  return executeOrchestratorTools(workspaceId, conversationId, contactId, envelope);
}

export const agentTestOrchestrator = createResponseOrchestrator({
  buildContext: buildConversationContext,
  executeTools: executeTestTools,
  generate: async (workspaceId: string, referenceId: string, messages: AIMessage[]) => {
    const response = await generateAIWithUsage(workspaceId, `agent-test:${referenceId}`, messages);
    return { text: response.text };
  },
});

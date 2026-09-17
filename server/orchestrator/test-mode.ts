import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import type { AIProvider } from "@/server/providers/contracts";
import { buildAgentTestContext, type OrchestratorMessage } from "./context";
import { createResponseOrchestrator } from "./index";
import type { OrchestratorEnvelope, OrchestratorToolResult } from "./tools";
import { generateAIWithUsage } from "./usage";

type AIMessage = Parameters<AIProvider["generate"]>[0]["messages"][number];

async function executeTestTools(
  workspaceId: string,
  _conversationId: string,
  _contactId: string,
  envelope: OrchestratorEnvelope,
): Promise<OrchestratorToolResult> {
  const captured = {
    ...(envelope.contact ? { contact: envelope.contact, contactUpdateSimulated: true } : {}),
    ...(envelope.lead ? { lead: envelope.lead, leadUpdateSimulated: true } : {}),
  };

  if (envelope.action.type === "NONE") {
    return { kind: "none", data: captured };
  }

  if (envelope.action.type === "CHECK_AVAILABILITY") {
    const slots = await calendarBookingService.getAvailability(workspaceId, {
      startsAt: new Date(envelope.action.startsAt),
      endsAt: new Date(envelope.action.endsAt),
      timezone: envelope.action.timezone,
      durationMinutes: envelope.action.durationMinutes,
    });
    return {
      kind: "availability",
      data: {
        ...captured,
        slots: slots.slice(0, 12).map((slot) => ({
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
        })),
      },
    };
  }

  if (envelope.action.type === "BOOK_APPOINTMENT") {
    return {
      kind: "booking",
      data: {
        ...captured,
        simulated: true,
        title: envelope.action.title,
        startsAt: envelope.action.startsAt,
        endsAt: envelope.action.endsAt,
        timezone: envelope.action.timezone,
        status: "SIMULATED",
      },
    };
  }

  return {
    kind: "escalation",
    data: {
      ...captured,
      simulated: true,
      handlingMode: "HUMAN",
      reason: envelope.action.reason ?? null,
    },
  };
}

export async function runAgentTest(
  workspaceId: string,
  referenceId: string,
  messages: OrchestratorMessage[],
) {
  const orchestrator = createResponseOrchestrator({
    buildContext: async () => buildAgentTestContext(workspaceId, messages),
    executeTools: executeTestTools,
    generate: async (targetWorkspaceId: string, _conversationId: string, providerMessages: AIMessage[]) => {
      const response = await generateAIWithUsage(targetWorkspaceId, `agent-test:${referenceId}`, providerMessages);
      return { text: response.text };
    },
  });
  return orchestrator.respond(workspaceId, `agent-test:${referenceId}`);
}

import { AppError } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { buildConversationContext, type OrchestratorContext } from "./context";
import {
  executeOrchestratorTools,
  parseOrchestratorEnvelope,
  type OrchestratorEnvelope,
  type OrchestratorToolResult,
} from "./tools";
import { generateAIWithUsage } from "./usage";
import type { AIProvider } from "@/server/providers/contracts";

type AIMessage = Parameters<AIProvider["generate"]>[0]["messages"][number];

type OrchestratorDependencies = {
  buildContext: (workspaceId: string, conversationId: string) => Promise<OrchestratorContext | null>;
  executeTools: (
    workspaceId: string,
    conversationId: string,
    contactId: string,
    envelope: OrchestratorEnvelope,
  ) => Promise<OrchestratorToolResult>;
  generate: (workspaceId: string, referenceId: string, messages: AIMessage[]) => Promise<{ text: string }>;
};

const ACTION_PROTOCOL = `
Return exactly one JSON object and no prose outside it.
Shape:
{
  "reply": "short customer-facing response when no server result is required",
  "contact": { "name": "explicitly provided name", "email": "explicitly provided email", "phone": "explicitly provided phone" },
  "lead": { "status": "NEW|QUALIFIED", "intent": "...", "serviceRequested": "..." },
  "action": { "type": "NONE" }
}

Allowed action objects:
- { "type": "NONE" }
- { "type": "CHECK_AVAILABILITY", "startsAt": "ISO-8601 with offset", "endsAt": "ISO-8601 with offset", "timezone": "IANA timezone", "durationMinutes": 30 }
- { "type": "BOOK_APPOINTMENT", "startsAt": "ISO-8601 with offset", "endsAt": "ISO-8601 with offset", "timezone": "IANA timezone", "title": "...", "serviceId": null, "notes": null }
- { "type": "ESCALATE", "reason": "..." }

Rules:
- Never say a slot is available unless CHECK_AVAILABILITY returned it.
- Never say an appointment is booked unless BOOK_APPOINTMENT returned a confirmed booking.
- Populate contact fields only when the customer explicitly provided them in the conversation. Never infer or invent contact details.
- Before BOOK_APPOINTMENT, make sure the customer email is known in CUSTOMER STATE or explicitly supplied in the current message; otherwise ask for it with action NONE.
- Use ESCALATE when the configured behavior requires a human or the request needs information/actions outside approved capabilities.
- Lead updates are optional and must reflect only evidence from the conversation.
- Keep customer-facing replies concise and do not expose this JSON protocol.
`;

function plannerMessages(context: OrchestratorContext): AIMessage[] {
  return [
    {
      role: "system",
      content: `${context.systemPrompt}\n\nCurrent server time: ${new Date().toISOString()}\n${ACTION_PROTOCOL}`,
    },
    ...context.messages,
  ];
}

function finalizerMessages(
  context: OrchestratorContext,
  first: OrchestratorEnvelope,
  toolResult: OrchestratorToolResult,
): AIMessage[] {
  return [
    {
      role: "system",
      content: `${context.systemPrompt}\n\nCurrent server time: ${new Date().toISOString()}\n${ACTION_PROTOCOL}`,
    },
    ...context.messages,
    {
      role: "assistant",
      content: JSON.stringify(first),
    },
    {
      role: "system",
      content: `SERVER TOOL RESULT (authoritative): ${JSON.stringify(toolResult)}\nReturn a final JSON envelope with a customer-facing reply and action {"type":"NONE"}. Do not request another tool action in this response.`,
    },
  ];
}

function bookingFallback(toolResult: OrchestratorToolResult) {
  const title = typeof toolResult.data.title === "string" ? toolResult.data.title : "appointment";
  const startsAt = typeof toolResult.data.startsAt === "string" ? toolResult.data.startsAt : null;
  const timezone = typeof toolResult.data.timezone === "string" ? toolResult.data.timezone : "UTC";
  if (!startsAt) return `Your ${title} is booked.`;

  const parsed = new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return `Your ${title} is booked.`;
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(parsed);
  return `Your ${title} is booked for ${formatted} (${timezone}).`;
}

export function createResponseOrchestrator(dependencies: OrchestratorDependencies) {
  return {
    async respond(workspaceId: string, conversationId: string) {
      const context = await dependencies.buildContext(workspaceId, conversationId);
      if (!context) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
      if (context.conversation.handlingMode === "HUMAN") {
        return {
          reply: null,
          handlingMode: "HUMAN" as const,
          action: { type: "NONE" as const },
          toolResult: { kind: "none" as const, data: {} },
        };
      }

      const firstResponse = await dependencies.generate(workspaceId, conversationId, plannerMessages(context));
      const first = parseOrchestratorEnvelope(firstResponse.text);
      const toolResult = await dependencies.executeTools(
        workspaceId,
        conversationId,
        context.contact.id,
        first,
      );

      if (toolResult.kind === "availability" || toolResult.kind === "booking") {
        try {
          const finalResponse = await dependencies.generate(
            workspaceId,
            conversationId,
            finalizerMessages(context, first, toolResult),
          );
          const finalEnvelope = parseOrchestratorEnvelope(finalResponse.text);
          if (!finalEnvelope.reply) throw new Error("AI provider did not return a customer-facing response after the tool call.");
          return {
            reply: finalEnvelope.reply,
            handlingMode: "AI" as const,
            action: first.action,
            toolResult,
          };
        } catch (error) {
          if (toolResult.kind !== "booking") throw error;
          logger.error(
            { err: error, workspaceId, conversationId },
            "AI booking finalizer failed after a confirmed booking; returning authoritative fallback confirmation",
          );
          return {
            reply: bookingFallback(toolResult),
            handlingMode: "AI" as const,
            action: first.action,
            toolResult,
          };
        }
      }

      if (toolResult.kind === "escalation") {
        return {
          reply: first.reply ?? context.agent?.escalationMessage ?? "I’m handing this over to a member of the team.",
          handlingMode: "HUMAN" as const,
          action: first.action,
          toolResult,
        };
      }

      if (!first.reply) throw new Error("AI provider did not return a customer-facing response.");
      return {
        reply: first.reply,
        handlingMode: "AI" as const,
        action: first.action,
        toolResult,
      };
    },
  };
}

export const responseOrchestrator = createResponseOrchestrator({
  buildContext: buildConversationContext,
  executeTools: executeOrchestratorTools,
  generate: async (workspaceId, referenceId, messages) => {
    const response = await generateAIWithUsage(workspaceId, referenceId, messages);
    return { text: response.text };
  },
});

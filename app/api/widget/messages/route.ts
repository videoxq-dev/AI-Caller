import { getBookingPreviewCard } from "@/server/booking/cards";
import { handleBookingTurn } from "@/server/booking/conversation";
import {
  handleAppointmentManagementTurn, recordAppointmentManagementPreviewDelivery,
} from "@/server/booking/management";
import { upgradeWebchatBookingSession } from "@/server/booking/rollout";
import { recordBookingPreviewDelivery } from "@/server/booking/offers";
import { appendMessage, getConversationById } from "@/server/domain/core/repository";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { logger } from "@/server/observability/logger";
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
    const workspaceId = resolved.session.workspaceId;
    const bookingContext = {
      workspaceId, contactId: resolved.session.contactId,
      conversationId: resolved.session.conversationId,
      channel: "WEBCHAT" as const, sessionKey: resolved.session.id,
    };
    const claim = await claimWebchatTurn(workspaceId, resolved.session.id, input.clientMessageId);
    if (claim.state === "in_progress") {
      throw new AppError("WEBCHAT_TURN_IN_PROGRESS", "This message is already being processed.", 409);
    }
    if (claim.state === "failed") {
      throw new AppError(
        "WEBCHAT_TURN_FAILED",
        "This message was not automatically retried because the previous processing result is uncertain. Send a new message if you still need help.",
        409,
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(event("status", { state: claim.state === "completed" ? "cached" : "thinking" }));

          if (claim.state === "completed") {
            if (claim.responseText) {
              enqueueReply(controller, claim.responseText);
            } else {
              // A null cached reply may represent a paused agent or human
              // ownership. Do not invent a human handoff after a retry.
              const current = await getConversationById(workspaceId, resolved.session.conversationId);
              if (current?.handlingMode === "HUMAN") {
                controller.enqueue(event("handoff", { message: "A team member is handling this conversation." }));
              } else {
                controller.enqueue(event("notice", { message: "This message did not receive an automatic reply. Please try again later or contact the business directly." }));
              }
            }

            if (claim.responseMetadata.bookingCard) controller.enqueue(event("booking", claim.responseMetadata.bookingCard));
            controller.enqueue(event("done", { cached: true, agentAvailable: Boolean(claim.responseText) }));
            controller.close();
            return;
          }

          resolved.session = await upgradeWebchatBookingSession(resolved.session, input.message, claim.turnId);
          logger.info({ workspaceId, sessionId: resolved.session.id,
            conversationId: resolved.session.conversationId,
            bookingEngineVersion: resolved.session.bookingEngineVersion }, "Web chat turn booking engine selected");
          const externalBase = `${resolved.session.id}:${input.clientMessageId}`;
          const inbound = await appendMessage(workspaceId, resolved.session.conversationId, {
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

          const existingReply = await findWebchatAIResponse(workspaceId, `${externalBase}:reply`);
          if (existingReply) {

            const recoveredCard = existingReply.metadata.bookingCard;
            if (typeof existingReply.metadata.appointmentManagementRequestId === "string") {
              await recordAppointmentManagementPreviewDelivery(
                bookingContext, existingReply.metadata.appointmentManagementRequestId, existingReply.id,
                Number(existingReply.metadata.appointmentManagementVersion),
              );
            }
            if (typeof existingReply.metadata.bookingPreviewId === "string") {
              await recordBookingPreviewDelivery(bookingContext, {
                draftId: String(existingReply.metadata.bookingDraftId),
                previewId: existingReply.metadata.bookingPreviewId,
                expectedVersion: Number(existingReply.metadata.bookingVersion),
                deliveryChannel: "WEBCHAT", deliveryReference: existingReply.id,
              });
            }
            await completeWebchatTurn(workspaceId, claim.turnId, existingReply.body,
              recoveredCard && typeof recoveredCard === "object"
                ? { bookingCard: recoveredCard } : {});
            enqueueReply(controller, existingReply.body);
            if (recoveredCard) controller.enqueue(event("booking", recoveredCard));
            controller.enqueue(event("done", { cached: true }));
            controller.close();
            return;
          }

          const conversationBefore = await getConversationById(workspaceId, resolved.session.conversationId);
          const managementTurn = conversationBefore?.handlingMode === "AI"
            ? await handleAppointmentManagementTurn(
                bookingContext, { id: inbound.id, body: input.message },
              )
            : null;
          const bookingTurn = !managementTurn &&
            resolved.session.bookingEngineVersion === "v2" &&
            conversationBefore?.handlingMode === "AI"
              ? await handleBookingTurn(bookingContext, { id: inbound.id, body: input.message })
              : null;
          const result = managementTurn || bookingTurn
            ? {
              reply: (managementTurn ?? bookingTurn)!.reply, handlingMode: "AI" as const,
              action: { type: "NONE" as const },
              toolResult: { kind: "none" as const, data: {} },
            }
            : await responseOrchestrator.respond(workspaceId, resolved.session.conversationId);
          if (!result.reply) {
            await completeWebchatTurn(workspaceId, claim.turnId, null);
            if (result.handlingMode === "HUMAN") {
              controller.enqueue(event("handoff", { message: "A team member is handling this conversation." }));
            } else {
              controller.enqueue(event("unavailable", {
                message: "The AI assistant is currently unavailable. Your message is saved. Please try again later or contact the business directly.",
              }));
            }
            controller.enqueue(event("done", { handlingMode: result.handlingMode, agentAvailable: false }));
            controller.close();
            return;
          }

          const latestConversation = await getConversationById(workspaceId, resolved.session.conversationId);
          // Issue-scoped escalation leaves AI ownership intact. Only a separate
          // manual takeover may suppress the AI reply between planning and send.
          if (!latestConversation || latestConversation.handlingMode !== "AI") {
            await completeWebchatTurn(workspaceId, claim.turnId, null);
            controller.enqueue(event("handoff", { message: "A team member is handling this conversation." }));
            controller.enqueue(event("done", { handlingMode: "HUMAN" }));
            controller.close();
            return;
          }

          const bookingCard = bookingTurn?.preview
            ? await getBookingPreviewCard(bookingContext, bookingTurn.preview.previewId)
            : null;
          const saved = await appendMessage(workspaceId, resolved.session.conversationId, {
            channel: "WEBCHAT",
            direction: "OUTBOUND",
            senderType: "AI",
            contentType: "TEXT",
            body: result.reply,
            provider: "webchat-ai",
            externalMessageId: `${externalBase}:reply`,
            status: "DELIVERED",
            metadata: {
              action: result.action.type, toolResult: result.toolResult.kind,
              ...(managementTurn?.preview
                ? { appointmentManagementRequestId: managementTurn.preview.requestId,
                    appointmentManagementVersion: managementTurn.preview.version }
                : {}),
              ...(bookingTurn?.preview ? {
                bookingPreviewId: bookingTurn.preview.previewId,
                bookingDraftId: bookingTurn.preview.draftId,
                bookingVersion: bookingTurn.preview.version,
                bookingCard,
              } : {}),
            },
          });

          if (managementTurn?.preview) {
            await recordAppointmentManagementPreviewDelivery(
              bookingContext, managementTurn.preview.requestId, saved.id,
              managementTurn.preview.version,
            );
          }
          if (bookingTurn?.preview) {
            await recordBookingPreviewDelivery(bookingContext, {
              draftId: bookingTurn.preview.draftId,
              previewId: bookingTurn.preview.previewId,
              expectedVersion: bookingTurn.preview.version,
              deliveryChannel: "WEBCHAT", deliveryReference: saved.id,
            });
          }
          await completeWebchatTurn(workspaceId, claim.turnId, saved.body,
            bookingCard ? { bookingCard } : {});
          enqueueReply(controller, saved.body);
          if (bookingCard) controller.enqueue(event("booking", bookingCard));
          controller.enqueue(event("done", { handlingMode: "AI" }));
          controller.close();
        } catch (error) {
          await failWebchatTurn(workspaceId, claim.turnId, error).catch(() => undefined);
          logger.error(
            { err: error, workspaceId, sessionId: resolved.session.id, conversationId: resolved.session.conversationId, turnId: claim.turnId },
            "Web chat turn processing failed",
          );
          controller.enqueue(event("error", { message: "Unable to process this message right now." }));
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

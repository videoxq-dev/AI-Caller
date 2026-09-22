import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { confirmAndExecuteBooking, getBookingOutcome } from "@/server/booking/commands";
import { getBookingPreviewCard } from "@/server/booking/cards";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { appendMessage } from "@/server/domain/core/repository";
import { resolveWebchatSession } from "@/server/webchat/repository";

const inputSchema = z.object({
  draftId: z.string().uuid(),
  previewId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  clientEventId: z.string().uuid(),
}).strict();

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
      throw new AppError("WEBCHAT_UNAUTHORIZED", "A valid widget session is required.", 401);
    }
    const resolved = await resolveWebchatSession(authorization.slice(7).trim());
    if (!resolved) throw new AppError("WEBCHAT_SESSION_EXPIRED", "Your chat session has expired.", 401);
    if (resolved.session.bookingEngineVersion !== "v2") {
      throw new AppError("BOOKING_ENGINE_UNAVAILABLE", "Start a new booking session to use this confirmation.", 409);
    }
    const parsed = inputSchema.safeParse(await request.json());
    if (!parsed.success) throw new AppError("BOOKING_CONFIRMATION_INVALID", "Booking confirmation was invalid.", 422);
    const input = parsed.data;
    const ctx = {
      workspaceId: resolved.session.workspaceId,
      contactId: resolved.session.contactId,
      conversationId: resolved.session.conversationId,
      sessionKey: resolved.session.id,
      channel: "WEBCHAT" as const,
    };
    const card = await getBookingPreviewCard(ctx, input.previewId);
    if (!card || card.draftId !== input.draftId || card.version !== input.expectedVersion) {
      throw new AppError("BOOKING_PREVIEW_STALE", "This booking preview is no longer available.", 409);
    }
    if (card.status === "STALE") {
      throw new AppError("BOOKING_PREVIEW_STALE", "The appointment has changed or expired. Please check again.", 409);
    }
    const source = await appendMessage(ctx.workspaceId, ctx.conversationId, {
      channel: "WEBCHAT", direction: "INBOUND", senderType: "CUSTOMER",
      contentType: "TEXT", body: "Yes, please.",
      provider: "webchat-booking-confirm",
      externalMessageId: ctx.sessionKey + ":" + input.clientEventId,
      status: "RECEIVED",
      metadata: { sessionId: ctx.sessionKey, bookingPreviewId: input.previewId,
        bookingDraftId: input.draftId, clientEventId: input.clientEventId },
    });
    const result = await confirmAndExecuteBooking(ctx, {
      draftId: input.draftId, expectedVersion: input.expectedVersion,
      previewId: input.previewId, sourceEventId: source.id,
    });
    const outcome = await getBookingOutcome(ctx, input.draftId);
    const appointment = outcome.appointment;
    const reply = outcome.state === "CONFIRMED" && appointment
      ? "Your " + appointment.title + " appointment is confirmed for " +
        new Intl.DateTimeFormat("en-US", {
          timeZone: card.timezone, dateStyle: "full", timeStyle: "short",
        }).format(appointment.startsAt) + " (" + card.timezone + ")."
      : result.state === "FAILED"
        ? "I couldn't complete this appointment. No new time was booked."
        : "I'm verifying the booking's final status. Please don't submit another appointment for the same time.";
    const responseId = ctx.sessionKey + ":" + input.previewId + ":confirmation-reply";
    const saved = await appendMessage(ctx.workspaceId, ctx.conversationId, {
      channel: "WEBCHAT", direction: "OUTBOUND", senderType: "AI",
      contentType: "TEXT", body: reply,
      provider: "webchat-booking-confirm",
      externalMessageId: responseId,
      status: "DELIVERED",
      metadata: {
        bookingReceipt: appointment ? {
          appointmentId: appointment.id, state: outcome.state,
          startsAt: appointment.startsAt.toISOString(),
          endsAt: appointment.endsAt.toISOString(),
          timezone: card.timezone,
        } : { state: outcome.state },
      },
    });
    return Response.json({
      reply: saved.body,
      status: outcome.state,
      bookingCard: { ...card, status: outcome.state === "CONFIRMED" ? "CONFIRMED" : "STALE" },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

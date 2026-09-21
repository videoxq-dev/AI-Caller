import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookingDrafts, bookingPreviews } from "@/db/schema";
import { getBookingDraft, type BookingContext } from "./drafts";

export type BookingCard = {
  draftId: string;
  previewId: string;
  version: number;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMinutes: number;
  requiredLocation: string | null;
  expiresAt: string;
  status: "AWAITING_CONFIRMATION" | "STALE" | "CONFIRMED";
};

// No browser-supplied business, booking, or appointment details are accepted.
export async function getBookingPreviewCard(
  context: BookingContext, previewId: string, now = new Date(),
): Promise<BookingCard | null> {
  const [preview] = await db.select().from(bookingPreviews).where(and(
    eq(bookingPreviews.id, previewId),
    eq(bookingPreviews.workspaceId, context.workspaceId),
  )).limit(1);
  if (!preview) return null;
  const draft = await getBookingDraft(context, preview.draftId);
  const content = preview.content;
  const status = draft.bookingCommandId && draft.currentPreviewId === previewId &&
    draft.status === "CONFIRMED" ? "CONFIRMED"
    : draft.currentPreviewId === previewId && draft.version === preview.draftVersion &&
      draft.status === "AWAITING_CONFIRMATION" &&
      preview.expiresAt > now && draft.expiresAt > now
        ? "AWAITING_CONFIRMATION" : "STALE";
  return {
    draftId: preview.draftId, previewId: preview.id, version: preview.draftVersion,
    serviceName: String(content.serviceName),
    startsAt: String(content.startsAt), endsAt: String(content.endsAt),
    timezone: String(content.timezone),
    durationMinutes: Number(content.durationMinutes),
    requiredLocation: typeof content.requiredLocation === "string"
      ? content.requiredLocation : null,
    expiresAt: preview.expiresAt.toISOString(), status,
  };
}

export async function listBookingCards(context: BookingContext, previewIds: string[], now = new Date()) {
  const results = await Promise.all(previewIds.slice(0, 40).map(async (id) => {
    try { return await getBookingPreviewCard(context, id, now); } catch { return null; }
  }));
  return results.filter((card): card is BookingCard => Boolean(card));
}

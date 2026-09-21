import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { bookingDrafts, bookingOffers, bookingPreviews, contacts, services, workspaces } from "@/db/schema";
import { getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { openBookingDraft, patchBookingDraft, type BookingContext } from "./drafts";
import {
  prepareBookingPreview, recordBookingPreviewDelivery,
  searchBookingAvailability, selectBookingOffer,
} from "./offers";

const now = new Date("2030-09-21T12:00:00.000Z");
function later(ms: number) { return new Date(now.getTime() + ms); }

describe("stored exact booking offers and previews (disposable PostgreSQL)", () => {
  let ctx: BookingContext;
  let serviceId: string;

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Booking offers" }).returning();
    const [contact] = await db.insert(contacts).values({ workspaceId: workspace.id, name: "Ada" }).returning();
    const [service] = await db.insert(services).values({
      workspaceId: workspace.id, name: "Office Cleaning", durationMinutes: 240,
    }).returning();
    serviceId = service.id;
    const conversation = await getOrCreateOpenConversation(workspace.id, contact.id);
    ctx = { workspaceId: workspace.id, contactId: contact.id,
      conversationId: conversation.id, channel: "WEBCHAT", sessionKey: "widget-one" };
    await saveBusinessSetup(workspace.id, {
      businessName: "Office Cleaning",
      timezone: "Africa/Lagos", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "19:00",
      })),
    });
  });
  afterAll(async () => closeDatabase());

  async function filled() {
    const started = await openBookingDraft(ctx, now);
    if (started.state !== "OPENED") throw new Error("Expected a fresh draft");
    const result = await patchBookingDraft(ctx, {
      draftId: started.draft.id, expectedVersion: 1, sourceEventId: "details-1",
      patch: { serviceId, localDate: "2030-09-23", localTime: "11:00",
        customerTimezone: "Africa/Lagos" },
    }, now);
    if (result.state !== "UPDATED") throw new Error("Expected an updated draft");
    return { id: started.draft.id, version: result.draft.version };
  }

  it("offers only the verified four-hour instant and persists a timezone-correct preview", async () => {
    const draft = await filled();
    const search = await searchBookingAvailability(ctx, {
      draftId: draft.id, expectedVersion: draft.version,
    }, now);
    expect(search.state).toBe("SLOTS_AVAILABLE");
    expect(search.offers).toHaveLength(1);
    expect(search.offers[0]).toMatchObject({
      serviceId, durationMinutes: 240, provider: "native", timezone: "Africa/Lagos",
      startsAt: new Date("2030-09-23T10:00:00Z"),
      endsAt: new Date("2030-09-23T14:00:00Z"),
    });
    const selected = await selectBookingOffer(ctx, {
      draftId: draft.id, expectedVersion: draft.version, offerId: search.offers[0].id,
    }, now);
    expect(selected.draft.version).toBe(3);
    const prepared = await prepareBookingPreview(ctx, {
      draftId: draft.id, expectedVersion: selected.draft.version,
    }, now);
    expect(prepared.preview.content).toMatchObject({
      serviceName: "Office Cleaning", durationMinutes: 240,
      startsAt: "2030-09-23T10:00:00.000Z",
      endsAt: "2030-09-23T14:00:00.000Z",
      displayStart: { localDate: "2030-09-23", localTime: "11:00", timezone: "Africa/Lagos" },
      displayEnd: { localDate: "2030-09-23", localTime: "15:00", timezone: "Africa/Lagos" },
    });
    expect(prepared.preview.deliveredAt).toBeNull();
    const delivered = await recordBookingPreviewDelivery(ctx, {
      draftId: draft.id, expectedVersion: 3, previewId: prepared.preview.id,
      deliveryChannel: "WEBCHAT", deliveryReference: "assistant-message-123",
    }, later(1000));
    expect(delivered.deliveredAt).toEqual(later(1000));
    expect((await db.select().from(bookingPreviews))).toHaveLength(1);
  });

  it("rejects an expired offer and cannot recycle a previous search's offer", async () => {
    const draft = await filled();
    const first = await searchBookingAvailability(ctx, {
      draftId: draft.id, expectedVersion: draft.version,
    }, now);
    const second = await searchBookingAvailability(ctx, {
      draftId: draft.id, expectedVersion: draft.version,
    }, later(30_000));
    await expect(selectBookingOffer(ctx, {
      draftId: draft.id, expectedVersion: draft.version, offerId: first.offers[0].id,
    }, later(31_000))).rejects.toMatchObject({ code: "BOOKING_OFFER_STALE" });
    await expect(selectBookingOffer(ctx, {
      draftId: draft.id, expectedVersion: draft.version, offerId: second.offers[0].id,
    }, later(6 * 60_000))).rejects.toMatchObject({ code: "BOOKING_OFFER_STALE" });
  });

  it("discards a preview after a customer changes the intended appointment time", async () => {
    const draft = await filled();
    const search = await searchBookingAvailability(ctx, {
      draftId: draft.id, expectedVersion: draft.version,
    }, now);
    const selected = await selectBookingOffer(ctx, {
      draftId: draft.id, expectedVersion: draft.version, offerId: search.offers[0].id,
    }, now);
    const preview = await prepareBookingPreview(ctx, {
      draftId: draft.id, expectedVersion: selected.draft.version,
    }, now);
    await patchBookingDraft(ctx, {
      draftId: draft.id, expectedVersion: 3, sourceEventId: "correction-2",
      patch: { localTime: "12:00" },
    }, later(1000));
    const [saved] = await db.select().from(bookingDrafts).where(eq(bookingDrafts.id, draft.id));
    expect(saved.currentPreviewId).toBeNull();
    expect(saved.selectedOfferId).toBeNull();
    expect(saved.currentSearchId).toBeNull();
    await expect(recordBookingPreviewDelivery(ctx, {
      draftId: draft.id, expectedVersion: 3, previewId: preview.preview.id,
      deliveryChannel: "WEBCHAT", deliveryReference: "late-message",
    }, later(2000))).rejects.toMatchObject({ code: "BOOKING_STALE_VERSION" });
    expect(await db.select().from(bookingOffers)).toHaveLength(1);
  });

  it("rejects foreign customer preview access even when the preview ID is known", async () => {
    const draft = await filled();
    const search = await searchBookingAvailability(ctx, {
      draftId: draft.id, expectedVersion: draft.version,
    }, now);
    await expect(selectBookingOffer({ ...ctx, sessionKey: "another-session" }, {
      draftId: draft.id, expectedVersion: draft.version, offerId: search.offers[0].id,
    }, now)).rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
    const [other] = await db.insert(contacts).values({
      workspaceId: ctx.workspaceId, name: "Another contact",
    }).returning();
    await expect(searchBookingAvailability({ ...ctx, contactId: other.id }, {
      draftId: draft.id, expectedVersion: draft.version,
    }, now)).rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
  });
});

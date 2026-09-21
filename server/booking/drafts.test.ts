import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { bookingDrafts, bookingSourceEvents, contacts, workspaces } from "@/db/schema";
import { getOrCreateOpenConversation } from "@/server/domain/core/repository";
import {
  cancelBookingDraft, getBookingDraft, openBookingDraft, patchBookingDraft,
  type BookingContext,
} from "./drafts";

const now = new Date("2030-09-21T12:00:00.000Z");

describe("durable booking draft boundaries (disposable PostgreSQL only)", () => {
  let context: BookingContext;
  let otherContact: string;
  let otherWorkspace: string;

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Drafts test" }).returning();
    const [contact] = await db.insert(contacts).values({ workspaceId: workspace.id, name: "Ada" }).returning();
    const [second] = await db.insert(contacts).values({ workspaceId: workspace.id, name: "Bola" }).returning();
    const [foreign] = await db.insert(workspaces).values({ name: "Other workspace" }).returning();
    const conversation = await getOrCreateOpenConversation(workspace.id, contact.id);
    context = {
      workspaceId: workspace.id,
      contactId: contact.id,
      conversationId: conversation.id,
      channel: "WEBCHAT",
      sessionKey: "widget-session-one",
    };
    otherContact = second.id;
    otherWorkspace = foreign.id;
  });

  afterAll(async () => closeDatabase());

  async function opened() {
    const result = await openBookingDraft(context, now);
    if (result.state !== "OPENED" && result.state !== "EXISTING") throw new Error("draft not opened");
    return result.draft;
  }

  it("preserves date and service across separate turns, ignoring omitted fields", async () => {
    const first = await opened();
    const dated = await patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 1, sourceEventId: "date-1",
      patch: { localDate: "2030-09-23", originalDateExpression: "Sep 23, 2030" },
    }, now);
    expect(dated.state).toBe("UPDATED");
    const timed = await patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 2, sourceEventId: "time-2",
      patch: { localTime: "11:00", customerTimezone: "Africa/Lagos" },
    }, now);
    expect(timed.state).toBe("UPDATED");
    const saved = await getBookingDraft(context, first.id);
    expect(saved).toMatchObject({
      localDate: "2030-09-23", originalDateExpression: "Sep 23, 2030",
      localTime: "11:00", customerTimezone: "Africa/Lagos", version: 3,
    });
    const followup = await patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 3, sourceEventId: "timezone-3",
      patch: { customerTimezone: "UTC" },
    }, now);
    expect(followup.state).toBe("UPDATED");
    expect((await getBookingDraft(context, first.id)).localDate).toBe("2030-09-23");
  });

  it("distinguishes unchanged fields from explicit clearing", async () => {
    const first = await opened();
    await patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 1, sourceEventId: "location",
      patch: { requiredLocation: "Office park" },
    }, now);
    const unchanged = await patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 2, sourceEventId: "same-location",
      patch: { requiredLocation: "Office park" },
    }, now);
    expect(unchanged.state).toBe("UNCHANGED");
    expect((await getBookingDraft(context, first.id)).version).toBe(2);
    const cleared = await patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 2, sourceEventId: "clear-location",
      patch: { requiredLocation: null },
    }, now);
    expect(cleared.state).toBe("UPDATED");
    expect((await getBookingDraft(context, first.id)).requiredLocation).toBeNull();
  });

  it("deduplicates a source event and rejects conflicting replay across operations", async () => {
    const first = await opened();
    const input = {
      draftId: first.id, expectedVersion: 1, sourceEventId: "turn-1",
      patch: { localDate: "2030-09-23" },
    };
    await patchBookingDraft(context, input, now);
    expect(await patchBookingDraft(context, input, now)).toEqual({ state: "REPLAY", version: 2 });
    expect((await db.select().from(bookingSourceEvents))).toHaveLength(1);
    await expect(patchBookingDraft({ ...context, contactId: otherContact }, input, now))
      .rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
    await expect(cancelBookingDraft(context, {
      draftId: first.id, expectedVersion: 2, sourceEventId: "turn-1",
    }, now)).rejects.toMatchObject({ code: "BOOKING_SOURCE_EVENT_CONFLICT" });
    expect((await getBookingDraft(context, first.id)).status).toBe("COLLECTING");
  });

  it("rejects stale writes and competing updates instead of losing corrections", async () => {
    const first = await opened();
    const results = await Promise.allSettled([
      patchBookingDraft(context, {
        draftId: first.id, expectedVersion: 1, sourceEventId: "turn-a", patch: { localDate: "2030-09-23" },
      }, now),
      patchBookingDraft(context, {
        draftId: first.id, expectedVersion: 1, sourceEventId: "turn-b", patch: { localDate: "2030-09-30" },
      }, now),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await getBookingDraft(context, first.id)).version).toBe(2);
    expect((await db.select().from(bookingSourceEvents))).toHaveLength(1);
  });

  it("isolates a new call, another widget session, another contact and workspace", async () => {
    const first = await opened();
    const nextCall = await openBookingDraft({
      ...context, channel: "PHONE", sessionKey: "call-123", conversationId: null,
    }, now);
    expect(nextCall.state).toBe("OPENED");
    if (nextCall.state === "OPENED") expect(nextCall.draft.id).not.toBe(first.id);
    const nextWidget = await openBookingDraft({ ...context, sessionKey: "widget-session-two" }, now);
    expect(nextWidget.state).toBe("OPENED");
    await expect(getBookingDraft({ ...context, contactId: otherContact }, first.id))
      .rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
    await expect(getBookingDraft({ ...context, workspaceId: otherWorkspace }, first.id))
      .rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
    await expect(getBookingDraft({ ...context, sessionKey: "widget-session-two" }, first.id))
      .rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
  });

  it("expires an unfinished session and opens a fresh draft without executing the old one", async () => {
    const first = await opened();
    const next = await openBookingDraft(context, new Date("2030-09-22T12:00:01.000Z"));
    expect(next.state).toBe("OPENED");
    if (next.state === "OPENED") expect(next.draft.id).not.toBe(first.id);
    expect((await getBookingDraft(context, first.id)).status).toBe("EXPIRED");
    expect(await db.select().from(bookingDrafts).where(eq(bookingDrafts.workspaceId, context.workspaceId)))
      .toHaveLength(2);
  });

  it("cancels only an uncommitted draft, with no appointment creation", async () => {
    const first = await opened();
    const result = await cancelBookingDraft(context, {
      draftId: first.id, expectedVersion: 1, sourceEventId: "cancel-1",
    }, now);
    expect(result.state).toBe("CANCELLED");
    expect(await cancelBookingDraft(context, {
      draftId: first.id, expectedVersion: 1, sourceEventId: "cancel-1",
    }, now)).toEqual({ state: "REPLAY", version: 2 });
    await expect(patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 2, sourceEventId: "late-patch", patch: { localTime: "11:00" },
    }, now)).rejects.toMatchObject({ code: "BOOKING_DRAFT_NOT_EDITABLE" });
    const fresh = await openBookingDraft(context, now);
    expect(fresh.state).toBe("OPENED");
  });

  it("rejects a service ID from another workspace and malformed timezones", async () => {
    const first = await opened();
    const [service] = await db.insert((await import("@/db/schema")).services).values({
      workspaceId: otherWorkspace, name: "Other company's service",
    }).returning();
    await expect(patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 1, sourceEventId: "cross-service", patch: { serviceId: service.id },
    }, now)).rejects.toMatchObject({ code: "BOOKING_SERVICE_NOT_FOUND" });
    await expect(patchBookingDraft(context, {
      draftId: first.id, expectedVersion: 1, sourceEventId: "invalid-zone",
      patch: { customerTimezone: "Mars/Olympus" },
    }, now)).rejects.toThrow();
  });
});

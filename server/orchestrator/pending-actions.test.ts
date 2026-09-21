import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { aiAgents, contacts, messages, pendingAgentActions, workspaces } from "@/db/schema";
import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { markPendingActionExecuted, stageOrConfirmPendingAction } from "./pending-actions";

describe("pending action commit gate", () => {
  let workspaceId = "";
  let contactId = "";
  let conversationId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Pending Action Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(aiAgents).values({ workspaceId, status: "ACTIVE", name: "Mia" });
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Ada" }).returning();
    contactId = contact.id;
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function customer(text: string) {
    await appendMessage(workspaceId, conversationId, {
      channel: "WEBCHAT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: text,
      provider: null,
      externalMessageId: null,
      status: "RECEIVED",
      metadata: {},
    });
  }

  const booking = {
    startsAt: "2037-09-23T10:00:00.000Z",
    endsAt: "2037-09-23T11:00:00.000Z",
    timezone: "UTC",
    title: "Office Cleaning",
    serviceId: null,
    notes: "30 North Gould Street",
  };

  it("never executes a consequential action on its first proposal", async () => {
    await customer("Book office cleaning for September 23 at 10 AM.");

    const result = await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: booking,
    });

    expect(result.state).toBe("AWAITING_CONFIRMATION");
    const [stored] = await db.select().from(pendingAgentActions);
    expect(stored).toMatchObject({ status: "AWAITING_CONFIRMATION", type: "BOOK_APPOINTMENT" });
  });

  it("commits only when a matching staged action receives explicit confirmation", async () => {
    await customer("Book office cleaning for September 23 at 10 AM.");
    await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: booking,
    });
    await customer("Yes, please.");

    const ready = await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: booking,
    });

    expect(ready.state).toBe("READY");
    expect(ready.action.confirmedAt).toBeInstanceOf(Date);
  });

  it("supersedes a proposal when the customer changes material details", async () => {
    await customer("Book office cleaning for September 23 at 10 AM.");
    await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: booking,
    });
    await customer("Actually make that 11 AM.");
    const changed = { ...booking, startsAt: "2037-09-23T11:00:00.000Z", endsAt: "2037-09-23T12:00:00.000Z" };

    const staged = await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: changed,
    });

    expect(staged.state).toBe("AWAITING_CONFIRMATION");
    const rows = await db.select().from(pendingAgentActions);
    expect(rows.map((row) => row.status).sort()).toEqual(["AWAITING_CONFIRMATION", "SUPERSEDED"]);
  });

  it("returns a persisted result receipt instead of repeating a committed action", async () => {
    await customer("Book office cleaning for September 23 at 10 AM.");
    await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: booking,
    });
    await customer("Yes.");
    const ready = await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: booking,
    });
    expect(ready.state).toBe("READY");
    await markPendingActionExecuted(workspaceId, ready.action.id, {
      appointmentId: "appointment-1",
      status: "CONFIRMED",
      ...booking,
    });

    const repeated = await stageOrConfirmPendingAction({
      workspaceId, conversationId, contactId, type: "BOOK_APPOINTMENT", payload: booking,
    });

    expect(repeated).toMatchObject({
      state: "EXECUTED",
      result: { appointmentId: "appointment-1", status: "CONFIRMED" },
    });
    expect(await db.select().from(pendingAgentActions)).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(2);
  });
});

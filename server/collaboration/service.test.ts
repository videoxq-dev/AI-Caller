import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  account,
  contactIdentities,
  contacts,
  conversationHandlingEvents,
  conversations,
  memberships,
  messages,
  notifications,
  session,
  user,
  verification,
  workspaceInvitations,
  workspaces,
} from "@/db/schema";
import { assignConversation, returnConversationToAI, takeOverConversation } from "./service";

const ownerId = "collab-owner";
const staffId = "collab-staff";
let workspaceId = "";
let conversationId = "";

describe("conversation collaboration", () => {
  beforeEach(async () => {
    await db.delete(notifications);
    await db.delete(conversationHandlingEvents);
    await db.delete(messages);
    await db.delete(conversations);
    await db.delete(contactIdentities);
    await db.delete(contacts);
    await db.delete(workspaceInvitations);
    await db.delete(session);
    await db.delete(account);
    await db.delete(verification);
    await db.delete(memberships);
    await db.delete(workspaces);
    await db.delete(user);

    await db.insert(user).values([
      { id: ownerId, name: "Owner", email: "owner.collab@example.com", emailVerified: true },
      { id: staffId, name: "Staff", email: "staff.collab@example.com", emailVerified: true },
    ]);
    const [workspace] = await db.insert(workspaces).values({ name: "Collaboration Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values([
      { workspaceId, userId: ownerId, role: "OWNER" },
      { workspaceId, userId: staffId, role: "STAFF" },
    ]);
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Customer" }).returning();
    const [conversation] = await db.insert(conversations).values({ workspaceId, contactId: contact.id }).returning();
    conversationId = conversation.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("takes over atomically and notifies a different assignee", async () => {
    const conversation = await takeOverConversation({
      workspaceId,
      conversationId,
      actorUserId: ownerId,
      assignedUserId: staffId,
      reason: "Customer requested a person",
    });

    expect(conversation.handlingMode).toBe("HUMAN");
    expect(conversation.assignedUserId).toBe(staffId);
    expect(conversation.aiPausedAt).toBeTruthy();

    const events = await db.select().from(conversationHandlingEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "TAKEOVER", actorUserId: ownerId, assignedUserId: staffId });

    const notices = await db.select().from(notifications);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: staffId, type: "CONVERSATION_ASSIGNED", conversationId });
  });

  it("does not duplicate a repeated identical takeover", async () => {
    await takeOverConversation({ workspaceId, conversationId, actorUserId: staffId });
    await takeOverConversation({ workspaceId, conversationId, actorUserId: staffId });
    const events = await db.select().from(conversationHandlingEvents);
    expect(events).toHaveLength(1);
  });

  it("audits assignment and return to AI", async () => {
    await assignConversation({ workspaceId, conversationId, actorUserId: ownerId, assignedUserId: staffId });
    const returned = await returnConversationToAI({ workspaceId, conversationId, actorUserId: ownerId });
    expect(returned.handlingMode).toBe("AI");
    expect(returned.assignedUserId).toBeNull();
    expect(returned.aiPausedAt).toBeNull();

    const events = await db.select().from(conversationHandlingEvents);
    expect(events.map((event) => event.type)).toEqual(["ASSIGNED", "RETURN_TO_AI"]);
  });

  it("rejects assignment to a user outside the workspace", async () => {
    await db.insert(user).values({ id: "outsider", name: "Outsider", email: "outside@example.com", emailVerified: true });
    await expect(assignConversation({
      workspaceId,
      conversationId,
      actorUserId: ownerId,
      assignedUserId: "outsider",
    })).rejects.toMatchObject({ code: "INVALID_ASSIGNEE" });
  });
});

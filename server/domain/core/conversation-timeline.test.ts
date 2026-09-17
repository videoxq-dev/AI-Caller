import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { contacts, conversations, messages, workspaces } from "@/db/schema";
import { getConversationTimelinePage } from "./conversation-timeline";

describe("conversation timeline pagination", () => {
  it("returns a bounded recent window in chronological order", async () => {
    const [workspace] = await db.insert(workspaces).values({ name: "Timeline Test" }).returning();
    const [otherWorkspace] = await db.insert(workspaces).values({ name: "Other Timeline Test" }).returning();

    try {
      const [contact] = await db.insert(contacts).values({ workspaceId: workspace.id, name: "Timeline Contact" }).returning();
      const [conversation] = await db.insert(conversations).values({ workspaceId: workspace.id, contactId: contact.id }).returning();
      const base = Date.now() - 10_000;

      await db.insert(messages).values([
        { workspaceId: workspace.id, conversationId: conversation.id, channel: "SMS", direction: "INBOUND", senderType: "CUSTOMER", contentType: "TEXT", body: "first", createdAt: new Date(base + 1_000) },
        { workspaceId: workspace.id, conversationId: conversation.id, channel: "WHATSAPP", direction: "OUTBOUND", senderType: "AI", contentType: "TEXT", body: "second", createdAt: new Date(base + 2_000) },
        { workspaceId: workspace.id, conversationId: conversation.id, channel: "WEBCHAT", direction: "INBOUND", senderType: "CUSTOMER", contentType: "TEXT", body: "third", createdAt: new Date(base + 3_000) },
      ]);

      const latest = await getConversationTimelinePage(workspace.id, conversation.id, { limit: 2, offset: 0 });
      expect(latest?.messages.map((message) => message.body)).toEqual(["second", "third"]);
      expect(latest?.totalMessages).toBe(3);
      expect(latest?.limit).toBe(2);
      expect(latest?.offset).toBe(0);

      const older = await getConversationTimelinePage(workspace.id, conversation.id, { limit: 2, offset: 2 });
      expect(older?.messages.map((message) => message.body)).toEqual(["first"]);
      expect(older?.totalMessages).toBe(3);

      expect(await getConversationTimelinePage(otherWorkspace.id, conversation.id)).toBeNull();
    } finally {
      await db.delete(workspaces).where((await import("drizzle-orm")).inArray(workspaces.id, [workspace.id, otherWorkspace.id]));
    }
  });

  afterAll(async () => {
    await closeDatabase();
  });
});

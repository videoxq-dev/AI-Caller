import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, conversations, messages } from "@/db/schema";

export type ConversationTimelineOptions = {
  limit?: number;
  offset?: number;
};

export async function getConversationTimelinePage(
  workspaceId: string,
  conversationId: string,
  options: ConversationTimelineOptions = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const [row] = await db.select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, conversations.contactId)))
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .limit(1);
  if (!row) return null;

  const [messageRows, countRows] = await Promise.all([
    db.select().from(messages).where(and(
      eq(messages.workspaceId, workspaceId),
      eq(messages.conversationId, conversationId),
    )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(messages).where(and(
      eq(messages.workspaceId, workspaceId),
      eq(messages.conversationId, conversationId),
    )),
  ]);

  return {
    ...row,
    messages: messageRows.reverse(),
    totalMessages: countRows[0]?.count ?? 0,
    limit,
    offset,
  };
}

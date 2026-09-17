import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";

export type ConversationChannel = "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT";

export async function listConversationChannels(workspaceId: string, conversationIds: string[]) {
  const uniqueIds = Array.from(new Set(conversationIds));
  if (!uniqueIds.length) return new Map<string, ConversationChannel[]>();

  const rows = await db.select({
    conversationId: messages.conversationId,
    channel: messages.channel,
  }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    inArray(messages.conversationId, uniqueIds),
  ));

  const channelsByConversation = new Map<string, ConversationChannel[]>();
  for (const row of rows) {
    const channels = channelsByConversation.get(row.conversationId) ?? [];
    if (!channels.includes(row.channel)) channels.push(row.channel);
    channelsByConversation.set(row.conversationId, channels);
  }

  return channelsByConversation;
}

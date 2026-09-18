import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { conversationHandlingEvents, conversations, memberships, notifications } from "@/db/schema";
import { AppError } from "@/server/http/errors";

async function conversationInWorkspace(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  conversationId: string,
) {
  const [conversation] = await tx.select().from(conversations).where(and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.id, conversationId),
  )).limit(1);
  if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
  return conversation;
}

async function ensureWorkspaceMember(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  userId: string,
) {
  const [membership] = await tx.select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  if (!membership) throw new AppError("INVALID_ASSIGNEE", "Assignee is not a member of this workspace.", 400);
  return membership;
}

export async function takeOverConversation(input: {
  workspaceId: string;
  conversationId: string;
  actorUserId: string;
  assignedUserId?: string | null;
  reason?: string | null;
}) {
  return db.transaction(async (tx) => {
    const current = await conversationInWorkspace(tx, input.workspaceId, input.conversationId);
    const assignedUserId = input.assignedUserId ?? input.actorUserId;
    await ensureWorkspaceMember(tx, input.workspaceId, assignedUserId);

    if (current.handlingMode === "HUMAN" && current.assignedUserId === assignedUserId) return current;

    const now = new Date();
    const [conversation] = await tx.update(conversations).set({
      handlingMode: "HUMAN",
      assignedUserId,
      aiPausedAt: current.aiPausedAt ?? now,
      updatedAt: now,
    }).where(and(
      eq(conversations.workspaceId, input.workspaceId),
      eq(conversations.id, input.conversationId),
    )).returning();

    await tx.insert(conversationHandlingEvents).values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      type: "TAKEOVER",
      actorUserId: input.actorUserId,
      assignedUserId,
      reason: input.reason?.trim() || null,
    });

    if (assignedUserId !== input.actorUserId) {
      await tx.insert(notifications).values({
        workspaceId: input.workspaceId,
        userId: assignedUserId,
        type: "CONVERSATION_ASSIGNED",
        title: "Conversation assigned to you",
        body: "A customer conversation was assigned to you for human follow-up.",
        conversationId: input.conversationId,
        contactId: current.contactId,
        metadata: { assignedByUserId: input.actorUserId },
      });
    }
    return conversation;
  });
}

export async function returnConversationToAI(input: {
  workspaceId: string;
  conversationId: string;
  actorUserId: string;
  reason?: string | null;
}) {
  return db.transaction(async (tx) => {
    const current = await conversationInWorkspace(tx, input.workspaceId, input.conversationId);
    if (current.handlingMode === "AI" && current.assignedUserId === null) return current;

    const [conversation] = await tx.update(conversations).set({
      handlingMode: "AI",
      assignedUserId: null,
      aiPausedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(conversations.workspaceId, input.workspaceId),
      eq(conversations.id, input.conversationId),
    )).returning();

    await tx.insert(conversationHandlingEvents).values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      type: "RETURN_TO_AI",
      actorUserId: input.actorUserId,
      reason: input.reason?.trim() || null,
    });
    return conversation;
  });
}

export async function assignConversation(input: {
  workspaceId: string;
  conversationId: string;
  actorUserId: string;
  assignedUserId: string | null;
}) {
  return db.transaction(async (tx) => {
    const current = await conversationInWorkspace(tx, input.workspaceId, input.conversationId);
    if (input.assignedUserId) await ensureWorkspaceMember(tx, input.workspaceId, input.assignedUserId);
    if (current.assignedUserId === input.assignedUserId) return current;

    const [conversation] = await tx.update(conversations).set({
      assignedUserId: input.assignedUserId,
      updatedAt: new Date(),
    }).where(and(
      eq(conversations.workspaceId, input.workspaceId),
      eq(conversations.id, input.conversationId),
    )).returning();

    await tx.insert(conversationHandlingEvents).values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      type: "ASSIGNED",
      actorUserId: input.actorUserId,
      assignedUserId: input.assignedUserId,
    });

    if (input.assignedUserId && input.assignedUserId !== input.actorUserId) {
      await tx.insert(notifications).values({
        workspaceId: input.workspaceId,
        userId: input.assignedUserId,
        type: "CONVERSATION_ASSIGNED",
        title: "Conversation assigned to you",
        body: "A customer conversation was assigned to you.",
        conversationId: input.conversationId,
        contactId: current.contactId,
        metadata: { assignedByUserId: input.actorUserId },
      });
    }
    return conversation;
  });
}

export async function listConversationHandlingEvents(workspaceId: string, conversationId: string, limit = 50) {
  return db.select().from(conversationHandlingEvents).where(and(
    eq(conversationHandlingEvents.workspaceId, workspaceId),
    eq(conversationHandlingEvents.conversationId, conversationId),
  )).orderBy(desc(conversationHandlingEvents.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
}

export async function listNotifications(workspaceId: string, userId: string, limit = 50) {
  return db.select().from(notifications).where(and(
    eq(notifications.workspaceId, workspaceId),
    or(eq(notifications.userId, userId), isNull(notifications.userId)),
  )).orderBy(desc(notifications.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
}

export async function markNotificationRead(workspaceId: string, userId: string, notificationId: string) {
  const [notification] = await db.update(notifications).set({ readAt: new Date() }).where(and(
    eq(notifications.workspaceId, workspaceId),
    eq(notifications.id, notificationId),
    or(eq(notifications.userId, userId), isNull(notifications.userId)),
  )).returning();
  if (!notification) throw new AppError("NOTIFICATION_NOT_FOUND", "Notification not found.", 404);
  return notification;
}

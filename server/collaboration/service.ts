import { createHash } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  automationEvents,
  conversationHandlingEvents,
  conversationHumanCases,
  conversations,
  memberships,
  messages,
  notifications,
} from "@/db/schema";
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

function issueFingerprint(reason: string) {
  return createHash("sha256").update(reason.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

async function latestCustomerMessage(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  conversationId: string,
) {
  const [message] = await tx.select({ id: messages.id }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.senderType, "CUSTOMER"),
  )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  return message?.id ?? null;
}

export async function escalateConversationIssue(input: {
  workspaceId: string;
  conversationId: string;
  reason?: string | null;
}) {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      select id from conversations
      where workspace_id = ${input.workspaceId} and id = ${input.conversationId}
      for update
    `);
    if (!locked.rowCount) {
      throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
    }
    const current = await conversationInWorkspace(tx, input.workspaceId, input.conversationId);
    const reason = input.reason?.trim() || "Customer issue needs staff follow-up.";
    const fingerprint = issueFingerprint(reason);
    const sourceMessageId = await latestCustomerMessage(tx, input.workspaceId, input.conversationId);

    const duplicateWhere = sourceMessageId
      ? and(
          eq(conversationHumanCases.workspaceId, input.workspaceId),
          eq(conversationHumanCases.conversationId, input.conversationId),
          eq(conversationHumanCases.sourceMessageId, sourceMessageId),
          eq(conversationHumanCases.fingerprint, fingerprint),
          or(eq(conversationHumanCases.status, "OPEN"), eq(conversationHumanCases.status, "CLAIMED")),
        )
      : and(
          eq(conversationHumanCases.workspaceId, input.workspaceId),
          eq(conversationHumanCases.conversationId, input.conversationId),
          eq(conversationHumanCases.fingerprint, fingerprint),
          or(eq(conversationHumanCases.status, "OPEN"), eq(conversationHumanCases.status, "CLAIMED")),
        );
    const [existing] = await tx.select().from(conversationHumanCases)
      .where(duplicateWhere).orderBy(desc(conversationHumanCases.createdAt)).limit(1);
    if (existing) return { conversation: current, issue: existing, created: false };

    const now = new Date();
    const [issue] = await tx.insert(conversationHumanCases).values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      contactId: current.contactId,
      sourceMessageId,
      fingerprint,
      reason,
      status: "OPEN",
      metadata: { handlingMode: current.handlingMode },
      createdAt: now,
      updatedAt: now,
    }).returning();

    await tx.insert(conversationHandlingEvents).values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      type: "ESCALATED",
      actorUserId: null,
      assignedUserId: null,
      reason,
      metadata: { issueCaseId: issue.id, scope: "ISSUE" },
    });

    await tx.insert(notifications).values({
      workspaceId: input.workspaceId,
      userId: null,
      type: "HUMAN_CASE_OPENED",
      title: "Customer issue needs follow-up",
      body: reason,
      conversationId: input.conversationId,
      contactId: current.contactId,
      metadata: { issueCaseId: issue.id, scope: "ISSUE" },
    });

    await tx.insert(automationEvents).values({
      workspaceId: input.workspaceId,
      type: "CONVERSATION_ESCALATED",
      aggregateType: "HUMAN_CASE",
      aggregateId: issue.id,
      payload: {
        conversationId: input.conversationId,
        contactId: current.contactId,
        issueCaseId: issue.id,
        reason,
        scope: "ISSUE",
      },
      occurredAt: now,
    }).onConflictDoNothing();

    return { conversation: current, issue, created: true };
  });
}

// Backwards-compatible name for call sites that mean automated escalation.
// Manual full-conversation ownership remains takeOverConversation().
export const escalateConversation = escalateConversationIssue;

export async function hasOpenConversationIssue(workspaceId: string, conversationId: string) {
  const [issue] = await db.select({ id: conversationHumanCases.id }).from(conversationHumanCases).where(and(
    eq(conversationHumanCases.workspaceId, workspaceId),
    eq(conversationHumanCases.conversationId, conversationId),
    or(eq(conversationHumanCases.status, "OPEN"), eq(conversationHumanCases.status, "CLAIMED")),
  )).limit(1);
  return Boolean(issue);
}

export async function listOpenConversationIssues(workspaceId: string, conversationId: string, limit = 20) {
  return db.select().from(conversationHumanCases).where(and(
    eq(conversationHumanCases.workspaceId, workspaceId),
    eq(conversationHumanCases.conversationId, conversationId),
    or(eq(conversationHumanCases.status, "OPEN"), eq(conversationHumanCases.status, "CLAIMED")),
  )).orderBy(desc(conversationHumanCases.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
}

export async function resolveConversationIssue(input: {
  workspaceId: string;
  conversationId: string;
  issueId: string;
  actorUserId: string;
}) {
  return db.transaction(async (tx) => {
    await conversationInWorkspace(tx, input.workspaceId, input.conversationId);
    const [currentIssue] = await tx.select().from(conversationHumanCases).where(and(
      eq(conversationHumanCases.workspaceId, input.workspaceId),
      eq(conversationHumanCases.conversationId, input.conversationId),
      eq(conversationHumanCases.id, input.issueId),
      or(eq(conversationHumanCases.status, "OPEN"), eq(conversationHumanCases.status, "CLAIMED")),
    )).limit(1);
    if (!currentIssue) throw new AppError("HUMAN_CASE_NOT_FOUND", "Open staff issue not found.", 404);

    const now = new Date();
    const [issue] = await tx.update(conversationHumanCases).set({
      status: "RESOLVED",
      resolvedAt: now,
      updatedAt: now,
      metadata: { ...currentIssue.metadata, resolvedByUserId: input.actorUserId },
    }).where(and(
      eq(conversationHumanCases.workspaceId, input.workspaceId),
      eq(conversationHumanCases.conversationId, input.conversationId),
      eq(conversationHumanCases.id, input.issueId),
      or(eq(conversationHumanCases.status, "OPEN"), eq(conversationHumanCases.status, "CLAIMED")),
    )).returning();
    if (!issue) throw new AppError("HUMAN_CASE_NOT_FOUND", "Open staff issue not found.", 404);
    return issue;
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

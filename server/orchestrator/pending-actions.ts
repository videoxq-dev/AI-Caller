import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, pendingAgentActions } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export type PendingActionType = "BOOK_APPOINTMENT" | "SEND_SMS";

const PENDING_ACTION_TTL_MS = 30 * 60 * 1000;

type PendingActionState =
  | { state: "AWAITING_CONFIRMATION"; action: typeof pendingAgentActions.$inferSelect }
  | { state: "READY"; action: typeof pendingAgentActions.$inferSelect }
  | { state: "EXECUTED"; action: typeof pendingAgentActions.$inferSelect; result: Record<string, unknown> };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function isExplicitActionConfirmation(text: string) {
  const normalized = text.trim().toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  if (!normalized || /\b(?:no|not|don't|do not|cancel|wait|hold on|instead|change)\b/i.test(normalized)) return false;
  return /^(?:yes|yes please|yep|yeah|sure|okay|ok|absolutely|please do|do it|go ahead|go ahead and do it|book it|confirm it|confirm|that works|sounds good|looks good|send it)$/i
    .test(normalized);
}

async function latestCustomerText(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  conversationId: string,
) {
  const [message] = await tx.select({ body: messages.body }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.senderType, "CUSTOMER"),
    inArray(messages.contentType, ["TEXT", "CALL_TRANSCRIPT"]),
  )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  return message?.body ?? "";
}

export async function getAwaitingPendingAction(workspaceId: string, conversationId: string) {
  const [action] = await db.select().from(pendingAgentActions).where(and(
    eq(pendingAgentActions.workspaceId, workspaceId),
    eq(pendingAgentActions.conversationId, conversationId),
    eq(pendingAgentActions.status, "AWAITING_CONFIRMATION"),
  )).orderBy(desc(pendingAgentActions.createdAt)).limit(1);
  if (!action) return null;
  if (Date.now() - action.createdAt.getTime() <= PENDING_ACTION_TTL_MS) return action;
  await db.update(pendingAgentActions).set({
    status: "EXPIRED",
    updatedAt: new Date(),
  }).where(and(
    eq(pendingAgentActions.workspaceId, workspaceId),
    eq(pendingAgentActions.id, action.id),
    eq(pendingAgentActions.status, "AWAITING_CONFIRMATION"),
  ));
  return null;
}

export async function stagePendingActionProposal(input: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  type: PendingActionType;
  payload: Record<string, unknown>;
}): Promise<PendingActionState> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.workspaceId}:${input.conversationId}`}))`);
    const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(and(
      eq(conversations.workspaceId, input.workspaceId),
      eq(conversations.id, input.conversationId),
    )).limit(1);
    if (!conversation) {
      throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
    }

    const hash = payloadHash(input.payload);
    const [completed] = await tx.select().from(pendingAgentActions).where(and(
      eq(pendingAgentActions.workspaceId, input.workspaceId),
      eq(pendingAgentActions.conversationId, input.conversationId),
      eq(pendingAgentActions.type, input.type),
      eq(pendingAgentActions.payloadHash, hash),
      eq(pendingAgentActions.status, "EXECUTED"),
    )).orderBy(desc(pendingAgentActions.executedAt), desc(pendingAgentActions.createdAt)).limit(1);
    if (completed?.result && typeof completed.result === "object") {
      return { state: "EXECUTED", action: completed, result: completed.result };
    }

    let [awaiting] = await tx.select().from(pendingAgentActions).where(and(
      eq(pendingAgentActions.workspaceId, input.workspaceId),
      eq(pendingAgentActions.conversationId, input.conversationId),
      eq(pendingAgentActions.type, input.type),
      eq(pendingAgentActions.status, "AWAITING_CONFIRMATION"),
    )).orderBy(desc(pendingAgentActions.createdAt)).limit(1);
    const now = new Date();
    if (awaiting && now.getTime() - awaiting.createdAt.getTime() > PENDING_ACTION_TTL_MS) {
      await tx.update(pendingAgentActions).set({
        status: "EXPIRED",
        updatedAt: now,
      }).where(eq(pendingAgentActions.id, awaiting.id));
      awaiting = undefined;
    }
    if (awaiting?.payloadHash === hash) {
      return { state: "AWAITING_CONFIRMATION", action: awaiting };
    }

    if (awaiting) {
      await tx.update(pendingAgentActions).set({
        status: "SUPERSEDED",
        updatedAt: now,
      }).where(eq(pendingAgentActions.id, awaiting.id));
    }

    const [created] = await tx.insert(pendingAgentActions).values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      type: input.type,
      payload: input.payload,
      payloadHash: hash,
      status: "AWAITING_CONFIRMATION",
    }).returning();
    return { state: "AWAITING_CONFIRMATION", action: created };
  });
}

export async function stageOrConfirmPendingAction(input: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  type: PendingActionType;
  payload: Record<string, unknown>;
}): Promise<PendingActionState> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.workspaceId}:${input.conversationId}`}))`);
    const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(and(
      eq(conversations.workspaceId, input.workspaceId),
      eq(conversations.id, input.conversationId),
    )).limit(1);
    if (!conversation) {
      throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
    }

    const hash = payloadHash(input.payload);
    const [completed] = await tx.select().from(pendingAgentActions).where(and(
      eq(pendingAgentActions.workspaceId, input.workspaceId),
      eq(pendingAgentActions.conversationId, input.conversationId),
      eq(pendingAgentActions.type, input.type),
      eq(pendingAgentActions.payloadHash, hash),
      eq(pendingAgentActions.status, "EXECUTED"),
    )).orderBy(desc(pendingAgentActions.executedAt), desc(pendingAgentActions.createdAt)).limit(1);
    if (completed?.result && typeof completed.result === "object") {
      return { state: "EXECUTED", action: completed, result: completed.result };
    }

    const [confirmed] = await tx.select().from(pendingAgentActions).where(and(
      eq(pendingAgentActions.workspaceId, input.workspaceId),
      eq(pendingAgentActions.conversationId, input.conversationId),
      eq(pendingAgentActions.type, input.type),
      eq(pendingAgentActions.payloadHash, hash),
      eq(pendingAgentActions.status, "CONFIRMED"),
    )).orderBy(desc(pendingAgentActions.updatedAt)).limit(1);
    if (confirmed) {
      const latestText = await latestCustomerText(tx, input.workspaceId, input.conversationId);
      if (isExplicitActionConfirmation(latestText)) return { state: "READY", action: confirmed };
      await tx.update(pendingAgentActions).set({
        status: "SUPERSEDED",
        updatedAt: new Date(),
      }).where(eq(pendingAgentActions.id, confirmed.id));
    }

    let [awaiting] = await tx.select().from(pendingAgentActions).where(and(
      eq(pendingAgentActions.workspaceId, input.workspaceId),
      eq(pendingAgentActions.conversationId, input.conversationId),
      eq(pendingAgentActions.type, input.type),
      eq(pendingAgentActions.status, "AWAITING_CONFIRMATION"),
    )).orderBy(desc(pendingAgentActions.createdAt)).limit(1);

    const now = new Date();
    if (awaiting && now.getTime() - awaiting.createdAt.getTime() > PENDING_ACTION_TTL_MS) {
      await tx.update(pendingAgentActions).set({
        status: "EXPIRED",
        updatedAt: now,
      }).where(eq(pendingAgentActions.id, awaiting.id));
      awaiting = undefined;
    }
    const latestText = await latestCustomerText(tx, input.workspaceId, input.conversationId);
    if (awaiting?.payloadHash === hash) {
      if (!isExplicitActionConfirmation(latestText)) {
        return { state: "AWAITING_CONFIRMATION", action: awaiting };
      }
      const [confirmedAction] = await tx.update(pendingAgentActions).set({
        status: "CONFIRMED",
        confirmedAt: now,
        updatedAt: now,
      }).where(eq(pendingAgentActions.id, awaiting.id)).returning();
      return { state: "READY", action: confirmedAction };
    }

    if (awaiting) {
      await tx.update(pendingAgentActions).set({
        status: "SUPERSEDED",
        updatedAt: now,
      }).where(eq(pendingAgentActions.id, awaiting.id));
    }

    const [created] = await tx.insert(pendingAgentActions).values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      type: input.type,
      payload: input.payload,
      payloadHash: hash,
      status: "AWAITING_CONFIRMATION",
    }).returning();
    return { state: "AWAITING_CONFIRMATION", action: created };
  });
}

export async function markPendingActionExecuted(
  workspaceId: string,
  actionId: string,
  result: Record<string, unknown>,
) {
  const [updated] = await db.update(pendingAgentActions).set({
    status: "EXECUTED",
    executedAt: new Date(),
    updatedAt: new Date(),
    failureCode: null,
    result,
  }).where(and(
    eq(pendingAgentActions.workspaceId, workspaceId),
    eq(pendingAgentActions.id, actionId),
  )).returning();
  if (!updated) throw new AppError("PENDING_ACTION_NOT_FOUND", "Pending action not found.", 404);
  return updated;
}

export async function markPendingActionFailed(
  workspaceId: string,
  actionId: string,
  failureCode: string,
) {
  const [updated] = await db.update(pendingAgentActions).set({
    status: "FAILED",
    failureCode: failureCode.slice(0, 200),
    updatedAt: new Date(),
  }).where(and(
    eq(pendingAgentActions.workspaceId, workspaceId),
    eq(pendingAgentActions.id, actionId),
  )).returning();
  return updated ?? null;
}

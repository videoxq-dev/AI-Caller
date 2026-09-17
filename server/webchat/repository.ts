import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  aiAgents,
  businessProfiles,
  messages,
  webchatSessions,
  webchatTurns,
  webchatWidgets,
  workspaces,
} from "@/db/schema";
import { getConversationTimelinePage } from "@/server/domain/core/conversation-timeline";
import { getOrCreateContactByIdentity, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import type { WebchatSessionInput } from "./schemas";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TURN_LEASE_MS = 2 * 60 * 1000;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function publicKey() {
  return `wc_${randomBytes(18).toString("base64url")}`;
}

export async function ensureWebchatWidget(workspaceId: string) {
  const [existing] = await db.select().from(webchatWidgets).where(eq(webchatWidgets.workspaceId, workspaceId)).limit(1);
  if (existing) return existing;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [created] = await db.insert(webchatWidgets).values({ workspaceId, publicKey: publicKey() })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [raced] = await db.select().from(webchatWidgets).where(eq(webchatWidgets.workspaceId, workspaceId)).limit(1);
    if (raced) return raced;
  }
  throw new Error("Unable to create a public web chat widget key.");
}

export async function getPublicWebchatWidget(widgetKey: string) {
  const [row] = await db.select({
    widget: webchatWidgets,
    business: businessProfiles,
    agent: aiAgents,
  }).from(webchatWidgets)
    .innerJoin(workspaces, and(eq(workspaces.id, webchatWidgets.workspaceId), eq(workspaces.status, "ACTIVE")))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, webchatWidgets.workspaceId))
    .leftJoin(aiAgents, eq(aiAgents.workspaceId, webchatWidgets.workspaceId))
    .where(and(eq(webchatWidgets.publicKey, widgetKey), eq(webchatWidgets.enabled, true)))
    .limit(1);
  if (!row) return null;
  return {
    workspaceId: row.widget.workspaceId,
    publicKey: row.widget.publicKey,
    launcherLabel: row.widget.launcherLabel,
    businessName: row.business?.businessName ?? "Business",
    assistantName: row.agent?.name ?? "AI Assistant",
    greeting: row.widget.greeting ?? row.agent?.openingMessage ?? "Hi! How can I help you today?",
  };
}

export async function resolveWebchatSession(token: string, expectedWidgetKey?: string) {
  const hash = tokenHash(token);
  const [row] = await db.select({ session: webchatSessions, widget: webchatWidgets })
    .from(webchatSessions)
    .innerJoin(webchatWidgets, and(
      eq(webchatWidgets.workspaceId, webchatSessions.workspaceId),
      eq(webchatWidgets.enabled, true),
    ))
    .innerJoin(workspaces, and(eq(workspaces.id, webchatSessions.workspaceId), eq(workspaces.status, "ACTIVE")))
    .where(and(eq(webchatSessions.tokenHash, hash), gt(webchatSessions.expiresAt, new Date())))
    .limit(1);
  if (!row || (expectedWidgetKey && row.widget.publicKey !== expectedWidgetKey)) return null;

  await db.update(webchatSessions).set({ lastSeenAt: new Date() }).where(eq(webchatSessions.id, row.session.id));
  return row;
}

async function sessionHistory(workspaceId: string, conversationId: string) {
  const timeline = await getConversationTimelinePage(workspaceId, conversationId, { limit: 30, offset: 0 });
  if (!timeline) return [];
  return timeline.messages.flatMap((message) => {
    if (message.contentType !== "TEXT") return [];
    if (message.senderType === "CUSTOMER") return [{ id: message.id, role: "customer" as const, text: message.body }];
    if (message.senderType === "AI" || message.senderType === "USER") {
      return [{ id: message.id, role: "assistant" as const, text: message.body }];
    }
    return [];
  });
}

export async function createOrResumeWebchatSession(input: WebchatSessionInput) {
  const widget = await getPublicWebchatWidget(input.widgetKey);
  if (!widget) return null;

  if (input.sessionToken) {
    const resumed = await resolveWebchatSession(input.sessionToken, input.widgetKey);
    if (resumed) {
      return {
        sessionToken: input.sessionToken,
        visitorId: resumed.session.visitorId,
        sessionId: resumed.session.id,
        conversationId: resumed.session.conversationId,
        widget,
        history: await sessionHistory(resumed.session.workspaceId, resumed.session.conversationId),
      };
    }
  }

  // Visitor IDs are identity hints, not credentials. A fresh session always receives a
  // server-generated visitor identity so a caller cannot claim another visitor's contact
  // or conversation merely by supplying a known identifier.
  const visitorId = `visitor_${randomUUID()}`;
  const contact = await getOrCreateContactByIdentity(widget.workspaceId, {
    channel: "WEBCHAT",
    externalId: visitorId,
    name: input.name ?? null,
    email: input.email ?? null,
  });
  const conversation = await getOrCreateOpenConversation(widget.workspaceId, contact.id);
  const sessionToken = randomBytes(32).toString("base64url");
  const [session] = await db.insert(webchatSessions).values({
    workspaceId: widget.workspaceId,
    contactId: contact.id,
    conversationId: conversation.id,
    visitorId,
    tokenHash: tokenHash(sessionToken),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  }).returning();

  return {
    sessionToken,
    visitorId,
    sessionId: session.id,
    conversationId: conversation.id,
    widget,
    history: [],
  };
}

export type WebchatTurnClaim =
  | { state: "claimed"; turnId: string }
  | { state: "completed"; turnId: string; responseText: string | null }
  | { state: "in_progress"; turnId: string };

export async function claimWebchatTurn(workspaceId: string, sessionId: string, clientMessageId: string): Promise<WebchatTurnClaim> {
  const [created] = await db.insert(webchatTurns).values({ workspaceId, sessionId, clientMessageId })
    .onConflictDoNothing()
    .returning();
  if (created) return { state: "claimed", turnId: created.id };

  const [existing] = await db.select().from(webchatTurns).where(and(
    eq(webchatTurns.workspaceId, workspaceId),
    eq(webchatTurns.sessionId, sessionId),
    eq(webchatTurns.clientMessageId, clientMessageId),
  )).limit(1);
  if (!existing) throw new Error("Unable to resolve the web chat turn after a conflict.");
  if (existing.status === "COMPLETED") return { state: "completed", turnId: existing.id, responseText: existing.responseText };

  if (existing.status === "FAILED") {
    const [reclaimed] = await db.update(webchatTurns).set({ status: "PROCESSING", error: null, updatedAt: new Date() })
      .where(and(
        eq(webchatTurns.workspaceId, workspaceId),
        eq(webchatTurns.id, existing.id),
        eq(webchatTurns.status, "FAILED"),
      ))
      .returning();
    if (reclaimed) return { state: "claimed", turnId: reclaimed.id };
  }

  if (existing.status === "PROCESSING") {
    const staleBefore = new Date(Date.now() - TURN_LEASE_MS);
    const [reclaimed] = await db.update(webchatTurns).set({ error: null, updatedAt: new Date() })
      .where(and(
        eq(webchatTurns.workspaceId, workspaceId),
        eq(webchatTurns.id, existing.id),
        eq(webchatTurns.status, "PROCESSING"),
        lt(webchatTurns.updatedAt, staleBefore),
      ))
      .returning();
    if (reclaimed) return { state: "claimed", turnId: reclaimed.id };
  }

  return { state: "in_progress", turnId: existing.id };
}

export async function completeWebchatTurn(workspaceId: string, turnId: string, responseText: string | null) {
  await db.update(webchatTurns).set({
    status: "COMPLETED",
    responseText,
    error: null,
    updatedAt: new Date(),
  }).where(and(eq(webchatTurns.workspaceId, workspaceId), eq(webchatTurns.id, turnId)));
}

export async function failWebchatTurn(workspaceId: string, turnId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown web chat turn failure";
  await db.update(webchatTurns).set({ status: "FAILED", error: message.slice(0, 2000), updatedAt: new Date() })
    .where(and(eq(webchatTurns.workspaceId, workspaceId), eq(webchatTurns.id, turnId)));
}

export async function findWebchatAIResponse(workspaceId: string, externalMessageId: string) {
  const [message] = await db.select().from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.provider, "webchat-ai"),
    eq(messages.externalMessageId, externalMessageId),
  )).orderBy(desc(messages.createdAt)).limit(1);
  return message ?? null;
}

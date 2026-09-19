import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  aiAgents,
  businessProfiles,
  messages,
  hostedPhoneNumbers,
  smsRegistrations,
  webchatSessions,
  webchatTurns,
  webchatWidgets,
  workspaces,
} from "@/db/schema";
import { getOrCreateContactByIdentity, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { AppError } from "@/server/http/errors";
import type { WebchatSessionInput } from "./schemas";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TURN_LEASE_MS = 2 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_NEW_SESSIONS_PER_WORKSPACE = 40;
const MAX_NEW_TURNS_PER_SESSION = 30;
const MAX_NEW_TURNS_PER_WORKSPACE = 300;

type WebchatHistoryMessage = {
  id: string;
  role: "customer" | "assistant";
  text: string;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function publicKey() {
  return `wc_${randomBytes(18).toString("base64url")}`;
}

async function assertNewSessionCapacity(workspaceId: string) {
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  const [row] = await db.select({ value: count() }).from(webchatSessions).where(and(
    eq(webchatSessions.workspaceId, workspaceId),
    gte(webchatSessions.createdAt, since),
  ));
  if ((row?.value ?? 0) >= MAX_NEW_SESSIONS_PER_WORKSPACE) {
    throw new AppError("WEBCHAT_RATE_LIMITED", "Too many new web chat sessions. Try again shortly.", 429);
  }
}

async function assertNewTurnCapacity(workspaceId: string, sessionId: string) {
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  const [workspaceCount, sessionCount] = await Promise.all([
    db.select({ value: count() }).from(webchatTurns).where(and(
      eq(webchatTurns.workspaceId, workspaceId),
      gte(webchatTurns.createdAt, since),
    )),
    db.select({ value: count() }).from(webchatTurns).where(and(
      eq(webchatTurns.sessionId, sessionId),
      gte(webchatTurns.createdAt, since),
    )),
  ]);
  if ((workspaceCount[0]?.value ?? 0) >= MAX_NEW_TURNS_PER_WORKSPACE || (sessionCount[0]?.value ?? 0) >= MAX_NEW_TURNS_PER_SESSION) {
    throw new AppError("WEBCHAT_RATE_LIMITED", "Too many chat messages. Try again shortly.", 429);
  }
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

export async function updateWebchatWidget(
  workspaceId: string,
  input: { greeting?: string | null; launcherLabel?: string },
) {
  await ensureWebchatWidget(workspaceId);
  const patch: Partial<typeof webchatWidgets.$inferInsert> = { updatedAt: new Date() };
  if (input.greeting !== undefined) patch.greeting = input.greeting?.trim() || null;
  if (input.launcherLabel !== undefined) patch.launcherLabel = input.launcherLabel.trim();
  const [updated] = await db.update(webchatWidgets)
    .set(patch)
    .where(eq(webchatWidgets.workspaceId, workspaceId))
    .returning();
  return updated;
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
  const [registration] = await db.select({ draft: smsRegistrations.draft }).from(smsRegistrations)
    .innerJoin(hostedPhoneNumbers, and(
      eq(hostedPhoneNumbers.id, smsRegistrations.phoneNumberId),
      eq(hostedPhoneNumbers.workspaceId, smsRegistrations.workspaceId),
      eq(hostedPhoneNumbers.status, "ACTIVE"),
    )).where(eq(smsRegistrations.workspaceId, row.widget.workspaceId)).limit(1);
  const [approved] = await db.select({ policy: smsRegistrations.approvedPolicy }).from(smsRegistrations)
    .where(and(eq(smsRegistrations.workspaceId, row.widget.workspaceId), eq(smsRegistrations.status, "READY"))).limit(1);
  const marketingProgramApproved = approved?.policy?.categories.includes("MARKETING") ?? false;
  const candidateTermsUrl = registration?.draft?.termsUrl;
  const smsTermsUrl = typeof candidateTermsUrl === "string" && /^https:\/\//i.test(candidateTermsUrl)
    ? candidateTermsUrl : null;
  return {
    smsTermsUrl,
    marketingProgramApproved,
    workspaceId: row.widget.workspaceId,
    publicKey: row.widget.publicKey,
    launcherLabel: row.widget.launcherLabel,
    businessName: row.business?.businessName ?? "Business",
    assistantName: row.agent?.name ?? "AI Assistant",
    greeting: row.widget.greeting ?? row.agent?.openingMessage ?? "Hi! How can I help you today?",
  };
}

export async function resolveWebchatSession(token: string, expectedWidgetKey?: string, touch = true) {
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

  if (touch) {
    await db.update(webchatSessions).set({ lastSeenAt: new Date() }).where(eq(webchatSessions.id, row.session.id));
  }
  return row;
}

export async function sessionHistory(workspaceId: string, conversationId: string): Promise<WebchatHistoryMessage[]> {
  const rows = await db.select({
    id: messages.id,
    senderType: messages.senderType,
    body: messages.body,
  }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.contentType, "TEXT"),
  )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(30);

  const history: WebchatHistoryMessage[] = [];
  for (const message of rows.reverse()) {
    if (message.senderType === "CUSTOMER") {
      history.push({ id: message.id, role: "customer", text: message.body });
    } else if (message.senderType === "AI" || message.senderType === "USER") {
      history.push({ id: message.id, role: "assistant", text: message.body });
    }
  }
  return history;
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

  await assertNewSessionCapacity(widget.workspaceId);

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
    history: [] as WebchatHistoryMessage[],
  };
}

export type WebchatTurnClaim =
  | { state: "claimed"; turnId: string }
  | { state: "completed"; turnId: string; responseText: string | null }
  | { state: "failed"; turnId: string }
  | { state: "in_progress"; turnId: string };

async function findWebchatTurn(workspaceId: string, sessionId: string, clientMessageId: string) {
  const [turn] = await db.select().from(webchatTurns).where(and(
    eq(webchatTurns.workspaceId, workspaceId),
    eq(webchatTurns.sessionId, sessionId),
    eq(webchatTurns.clientMessageId, clientMessageId),
  )).limit(1);
  return turn ?? null;
}

async function claimExistingTurn(workspaceId: string, existing: NonNullable<Awaited<ReturnType<typeof findWebchatTurn>>>): Promise<WebchatTurnClaim> {
  if (existing.status === "COMPLETED") {
    return { state: "completed", turnId: existing.id, responseText: existing.responseText };
  }
  if (existing.status === "FAILED") {
    return { state: "failed", turnId: existing.id };
  }

  if (existing.status === "PROCESSING") {
    const staleBefore = new Date(Date.now() - TURN_LEASE_MS);
    if (existing.updatedAt < staleBefore) {
      await db.update(webchatTurns).set({
        status: "FAILED",
        error: "Processing lease expired; automatic retry disabled to prevent duplicate external side effects.",
        updatedAt: new Date(),
      }).where(and(
        eq(webchatTurns.workspaceId, workspaceId),
        eq(webchatTurns.id, existing.id),
        eq(webchatTurns.status, "PROCESSING"),
        lt(webchatTurns.updatedAt, staleBefore),
      ));
      return { state: "failed", turnId: existing.id };
    }
  }

  return { state: "in_progress", turnId: existing.id };
}

export async function claimWebchatTurn(workspaceId: string, sessionId: string, clientMessageId: string): Promise<WebchatTurnClaim> {
  const existing = await findWebchatTurn(workspaceId, sessionId, clientMessageId);
  if (existing) return claimExistingTurn(workspaceId, existing);

  await assertNewTurnCapacity(workspaceId, sessionId);
  const [created] = await db.insert(webchatTurns).values({ workspaceId, sessionId, clientMessageId })
    .onConflictDoNothing()
    .returning();
  if (created) return { state: "claimed", turnId: created.id };

  const raced = await findWebchatTurn(workspaceId, sessionId, clientMessageId);
  if (!raced) throw new Error("Unable to resolve the web chat turn after a conflict.");
  return claimExistingTurn(workspaceId, raced);
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


export async function getWebchatSessionHistory(token: string) {
  const resolved = await resolveWebchatSession(token, undefined, false);
  if (!resolved) return null;
  return {
    history: await sessionHistory(resolved.session.workspaceId, resolved.session.conversationId),
    workspaceId: resolved.session.workspaceId,
    conversationId: resolved.session.conversationId,
  };
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  aiAgents,
  bookingDrafts,
  bookingPreviews,
  businessProfiles,
  messages,
  hostedPhoneNumbers,
  smsRegistrations,
  webchatSessions,
  webchatTurns,
  webchatWidgets,
  workspaces,
} from "@/db/schema";
import { isBookingV2Enabled } from "@/server/booking/rollout";
import { getWorkspaceIntegrationEntitlements } from "@/server/commerce/workspace-entitlements";
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
  booking?: Record<string, unknown>;
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

type WebchatWidgetUpdate = {
  name?: string;
  greeting?: string | null;
  launcherLabel?: string;
  enabled?: boolean;
};

async function requireUnlimitedWidgets(workspaceId: string) {
  const entitlement = await getWorkspaceIntegrationEntitlements(workspaceId);
  if (!entitlement.unlimited) {
    throw new AppError(
      "UNLIMITED_WIDGETS_REQUIRED",
      "Unlimited is required to create or manage additional website widgets.",
      403,
    );
  }
}

async function canServeWidget(widget: typeof webchatWidgets.$inferSelect) {
  if (widget.isPrimary) return true;
  return (await getWorkspaceIntegrationEntitlements(widget.workspaceId)).unlimited;
}

export async function ensureWebchatWidget(workspaceId: string) {
  const [existing] = await db.select().from(webchatWidgets).where(and(
    eq(webchatWidgets.workspaceId, workspaceId),
    eq(webchatWidgets.isPrimary, true),
  )).limit(1);
  if (existing) return existing;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [created] = await db.insert(webchatWidgets).values({
      workspaceId,
      publicKey: publicKey(),
      name: "Website chat",
      isPrimary: true,
    }).onConflictDoNothing().returning();
    if (created) return created;

    const [raced] = await db.select().from(webchatWidgets).where(and(
      eq(webchatWidgets.workspaceId, workspaceId),
      eq(webchatWidgets.isPrimary, true),
    )).limit(1);
    if (raced) return raced;
  }
  throw new Error("Unable to create a public web chat widget key.");
}

export async function listWebchatWidgets(workspaceId: string) {
  await ensureWebchatWidget(workspaceId);
  return db.select().from(webchatWidgets)
    .where(eq(webchatWidgets.workspaceId, workspaceId))
    .orderBy(desc(webchatWidgets.isPrimary), webchatWidgets.createdAt);
}

export async function createAdditionalWebchatWidget(
  workspaceId: string,
  input: { name: string; greeting?: string | null; launcherLabel?: string },
) {
  await requireUnlimitedWidgets(workspaceId);
  const [created] = await db.insert(webchatWidgets).values({
    workspaceId,
    publicKey: publicKey(),
    name: input.name.trim(),
    isPrimary: false,
    greeting: input.greeting?.trim() || null,
    launcherLabel: input.launcherLabel?.trim() || "Chat with us",
  }).returning();
  return created;
}

export async function updateWebchatWidgetById(
  workspaceId: string,
  widgetId: string,
  input: WebchatWidgetUpdate,
) {
  const [existing] = await db.select().from(webchatWidgets).where(and(
    eq(webchatWidgets.workspaceId, workspaceId),
    eq(webchatWidgets.id, widgetId),
  )).limit(1);
  if (!existing) throw new AppError("WIDGET_NOT_FOUND", "Web chat widget not found.", 404);

  if (!existing.isPrimary) {
    const safeDowngradeDisable = input.enabled === false
      && input.name === undefined
      && input.greeting === undefined
      && input.launcherLabel === undefined;
    if (!safeDowngradeDisable) await requireUnlimitedWidgets(workspaceId);
  }

  const patch: Partial<typeof webchatWidgets.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.greeting !== undefined) patch.greeting = input.greeting?.trim() || null;
  if (input.launcherLabel !== undefined) patch.launcherLabel = input.launcherLabel.trim();
  if (input.enabled !== undefined) patch.enabled = input.enabled;

  const [updated] = await db.update(webchatWidgets)
    .set(patch)
    .where(and(eq(webchatWidgets.workspaceId, workspaceId), eq(webchatWidgets.id, widgetId)))
    .returning();
  return updated;
}

export async function updateWebchatWidget(
  workspaceId: string,
  input: { greeting?: string | null; launcherLabel?: string },
) {
  const primary = await ensureWebchatWidget(workspaceId);
  return updateWebchatWidgetById(workspaceId, primary.id, input);
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
  if (!row || !(await canServeWidget(row.widget))) return null;
  const [registration] = await db.select({
    draft: smsRegistrations.draft,
    status: smsRegistrations.status,
    policy: smsRegistrations.approvedPolicy,
    readiness: hostedPhoneNumbers.messagingReadiness,
  }).from(smsRegistrations)
    .innerJoin(hostedPhoneNumbers, and(
      eq(hostedPhoneNumbers.id, smsRegistrations.phoneNumberId),
      eq(hostedPhoneNumbers.workspaceId, smsRegistrations.workspaceId),
      eq(hostedPhoneNumbers.status, "ACTIVE"),
    )).where(eq(smsRegistrations.workspaceId, row.widget.workspaceId)).limit(1);
  // Do not advertise marketing opt-in using an old, released number's campaign.
  const marketingProgramApproved = registration?.status === "READY" &&
    registration.readiness === "READY" &&
    (registration.policy?.categories.includes("MARKETING") ?? false);
  const candidateTermsUrl = registration?.draft?.termsUrl;
  const smsTermsUrl = typeof candidateTermsUrl === "string" && /^https:\/\//i.test(candidateTermsUrl)
    ? candidateTermsUrl : null;
  return {
    smsTermsUrl,
    marketingProgramApproved,
    id: row.widget.id,
    workspaceId: row.widget.workspaceId,
    publicKey: row.widget.publicKey,
    name: row.widget.name,
    isPrimary: row.widget.isPrimary,
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
      eq(webchatWidgets.id, webchatSessions.widgetId),
      eq(webchatWidgets.workspaceId, webchatSessions.workspaceId),
      eq(webchatWidgets.enabled, true),
    ))
    .innerJoin(workspaces, and(eq(workspaces.id, webchatSessions.workspaceId), eq(workspaces.status, "ACTIVE")))
    .where(and(eq(webchatSessions.tokenHash, hash), gt(webchatSessions.expiresAt, new Date())))
    .limit(1);
  if (!row || (expectedWidgetKey && row.widget.publicKey !== expectedWidgetKey)
    || !(await canServeWidget(row.widget))) return null;

  if (touch) {
    await db.update(webchatSessions).set({ lastSeenAt: new Date() }).where(eq(webchatSessions.id, row.session.id));
  }
  return row;
}

export async function sessionHistory(workspaceId: string, conversationId: string, sessionId?: string): Promise<WebchatHistoryMessage[]> {
  const rows = await db.select({
    id: messages.id,
    senderType: messages.senderType,
    body: messages.body,
    metadata: messages.metadata,
  }).from(messages).where(and(
    eq(messages.workspaceId, workspaceId),
    eq(messages.conversationId, conversationId),
    eq(messages.contentType, "TEXT"),
  )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(30);

  const previewIds = rows.map((row) => row.metadata?.bookingPreviewId)
    .filter((id): id is string => typeof id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id));
  const previewStatuses = new Map<string, "AWAITING_CONFIRMATION" | "STALE" | "CONFIRMED">();
  if (previewIds.length) {
    const previews = await db.select({
      preview: bookingPreviews, draft: bookingDrafts,
    }).from(bookingPreviews).innerJoin(bookingDrafts, eq(bookingDrafts.id, bookingPreviews.draftId))
      .where(and(eq(bookingPreviews.workspaceId, workspaceId),
        inArray(bookingPreviews.id, previewIds)));
    for (const row of previews) {
      const owner = !sessionId || row.draft.sessionKey === sessionId;
      const current = owner && row.draft.currentPreviewId === row.preview.id &&
        row.draft.version === row.preview.draftVersion;
      const status = current && row.draft.status === "CONFIRMED" ? "CONFIRMED"
        : current && row.draft.status === "AWAITING_CONFIRMATION" &&
          row.preview.expiresAt > new Date() && row.draft.expiresAt > new Date()
          ? "AWAITING_CONFIRMATION" : "STALE";
      previewStatuses.set(row.preview.id, status);
    }
  }
  const history: WebchatHistoryMessage[] = [];
  for (const message of rows.reverse()) {
    if (message.senderType === "CUSTOMER") {
      history.push({ id: message.id, role: "customer", text: message.body });
    } else if (message.senderType === "AI" || message.senderType === "USER") {
      const rawCard = message.metadata?.bookingCard;
      const previewId = message.metadata?.bookingPreviewId;
      const booking = rawCard && typeof rawCard === "object" && typeof previewId === "string"
        ? { ...(rawCard as Record<string, unknown>),
          status: previewStatuses.get(previewId) ?? "STALE" }
        : null;
      history.push({ id: message.id, role: "assistant", text: message.body,
        ...(booking ? { booking } : {}),
      });
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
        history: await sessionHistory(resumed.session.workspaceId, resumed.session.conversationId, resumed.session.id),
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
    widgetId: widget.id,
    contactId: contact.id,
    conversationId: conversation.id,
    visitorId,
    tokenHash: tokenHash(sessionToken),
    bookingEngineVersion: await isBookingV2Enabled(widget.workspaceId) ? "v2" : "v1",
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
  | { state: "completed"; turnId: string; responseText: string | null; responseMetadata: Record<string, unknown> }
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
    return { state: "completed", turnId: existing.id, responseText: existing.responseText,
      responseMetadata: existing.responseMetadata };
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

export async function completeWebchatTurn(
  workspaceId: string, turnId: string, responseText: string | null,
  responseMetadata: Record<string, unknown> = {},
) {
  await db.update(webchatTurns).set({
    status: "COMPLETED",
    responseText,
    responseMetadata,
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
    history: await sessionHistory(resolved.session.workspaceId, resolved.session.conversationId, resolved.session.id),
    workspaceId: resolved.session.workspaceId,
    conversationId: resolved.session.conversationId,
  };
}

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { webchatTurns, workspaces } from "@/db/schema";
import { appendMessage } from "@/server/domain/core/repository";
import {
  claimWebchatTurn,
  completeWebchatTurn,
  createOrResumeWebchatSession,
  ensureWebchatWidget,
  failWebchatTurn,
} from "./repository";

describe("web chat persistence", () => {
  let workspaceId = "";
  let widgetKey = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Web Chat Test" }).returning();
    workspaceId = workspace.id;
    widgetKey = (await ensureWebchatWidget(workspaceId)).publicKey;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("requires the secret session token before returning prior conversation history", async () => {
    const first = await createOrResumeWebchatSession({ widgetKey, visitorId: "visitor_client_hint_123" });
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected a web chat session.");

    await appendMessage(workspaceId, first.conversationId, {
      channel: "WEBCHAT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "This is private history.",
      provider: "webchat-customer",
      externalMessageId: "private-message-1",
      status: "RECEIVED",
      metadata: {},
    });

    const resumed = await createOrResumeWebchatSession({
      widgetKey,
      sessionToken: first.sessionToken,
      visitorId: first.visitorId,
    });
    expect(resumed?.visitorId).toBe(first.visitorId);
    expect(resumed?.history.map((message) => message.text)).toContain("This is private history.");

    const unauthenticated = await createOrResumeWebchatSession({
      widgetKey,
      visitorId: first.visitorId,
    });
    expect(unauthenticated?.visitorId).not.toBe(first.visitorId);
    expect(unauthenticated?.conversationId).not.toBe(first.conversationId);
    expect(unauthenticated?.history).toEqual([]);
  });

  it("deduplicates active and completed turns without replaying side effects", async () => {
    const session = await createOrResumeWebchatSession({ widgetKey });
    expect(session).not.toBeNull();
    if (!session) throw new Error("Expected a web chat session.");

    const clientMessageId = "10000000-0000-4000-8000-000000000001";
    const first = await claimWebchatTurn(workspaceId, session.sessionId, clientMessageId);
    expect(first.state).toBe("claimed");

    const duplicate = await claimWebchatTurn(workspaceId, session.sessionId, clientMessageId);
    expect(duplicate.state).toBe("in_progress");

    await completeWebchatTurn(workspaceId, first.turnId, "Cached response");
    const completed = await claimWebchatTurn(workspaceId, session.sessionId, clientMessageId);
    expect(completed).toEqual({ state: "completed", turnId: first.turnId, responseText: "Cached response" });
  });

  it("fails closed for failed or lease-expired turns instead of re-executing them", async () => {
    const session = await createOrResumeWebchatSession({ widgetKey });
    expect(session).not.toBeNull();
    if (!session) throw new Error("Expected a web chat session.");

    const failedMessageId = "10000000-0000-4000-8000-000000000002";
    const failedClaim = await claimWebchatTurn(workspaceId, session.sessionId, failedMessageId);
    expect(failedClaim.state).toBe("claimed");
    await failWebchatTurn(workspaceId, failedClaim.turnId, new Error("provider failed"));
    expect(await claimWebchatTurn(workspaceId, session.sessionId, failedMessageId)).toEqual({
      state: "failed",
      turnId: failedClaim.turnId,
    });

    const staleMessageId = "10000000-0000-4000-8000-000000000003";
    const staleClaim = await claimWebchatTurn(workspaceId, session.sessionId, staleMessageId);
    expect(staleClaim.state).toBe("claimed");
    await db.update(webchatTurns)
      .set({ updatedAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(webchatTurns.id, staleClaim.turnId));

    expect(await claimWebchatTurn(workspaceId, session.sessionId, staleMessageId)).toEqual({
      state: "failed",
      turnId: staleClaim.turnId,
    });
    const [stored] = await db.select().from(webchatTurns).where(eq(webchatTurns.id, staleClaim.turnId));
    expect(stored.status).toBe("FAILED");
  });

  it("rate limits anonymous session creation per workspace", async () => {
    for (let index = 0; index < 40; index += 1) {
      const session = await createOrResumeWebchatSession({ widgetKey });
      expect(session).not.toBeNull();
    }
    await expect(createOrResumeWebchatSession({ widgetKey })).rejects.toMatchObject({
      code: "WEBCHAT_RATE_LIMITED",
      status: 429,
    });
  });

  it("rate limits new message turns per session", async () => {
    const session = await createOrResumeWebchatSession({ widgetKey });
    expect(session).not.toBeNull();
    if (!session) throw new Error("Expected a web chat session.");

    for (let index = 0; index < 30; index += 1) {
      const id = `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      expect((await claimWebchatTurn(workspaceId, session.sessionId, id)).state).toBe("claimed");
    }
    await expect(claimWebchatTurn(workspaceId, session.sessionId, "20000000-0000-4000-8000-999999999999")).rejects.toMatchObject({
      code: "WEBCHAT_RATE_LIMITED",
      status: 429,
    });
  });
});

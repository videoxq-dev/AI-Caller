import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { webchatTurns, workspaces } from "@/db/schema";
import { appendMessage } from "@/server/domain/core/repository";
import {
  claimWebchatTurn,
  completeWebchatTurn,
  createOrResumeWebchatSession,
  ensureWebchatWidget,
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

  it("deduplicates active turns, caches completed responses, and reclaims stale processing leases", async () => {
    const session = await createOrResumeWebchatSession({ widgetKey });
    expect(session).not.toBeNull();
    if (!session) throw new Error("Expected a web chat session.");

    const clientMessageId = "10000000-0000-4000-8000-000000000001";
    const first = await claimWebchatTurn(workspaceId, session.sessionId, clientMessageId);
    expect(first.state).toBe("claimed");

    const duplicate = await claimWebchatTurn(workspaceId, session.sessionId, clientMessageId);
    expect(duplicate.state).toBe("in_progress");

    await db.update(webchatTurns)
      .set({ updatedAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where((table, { eq }) => eq(table.id, first.turnId));

    const reclaimed = await claimWebchatTurn(workspaceId, session.sessionId, clientMessageId);
    expect(reclaimed.state).toBe("claimed");
    expect(reclaimed.turnId).toBe(first.turnId);

    await completeWebchatTurn(workspaceId, first.turnId, "Cached response");
    const completed = await claimWebchatTurn(workspaceId, session.sessionId, clientMessageId);
    expect(completed).toEqual({ state: "completed", turnId: first.turnId, responseText: "Cached response" });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { pendingAgentActions, webchatSessions, workspaceEntitlements, workspaces } from "@/db/schema";
import { claimWebchatTurn, createOrResumeWebchatSession, ensureWebchatWidget } from "@/server/webchat/repository";
import { isBookingV2Enabled, shouldUseBookingV2, upgradeWebchatBookingSession } from "./rollout";
import { openBookingDraft } from "./drafts";

describe("booking engine rollout and safe legacy handoff", () => {
  let workspaceId: string;
  beforeEach(async () => {
    vi.unstubAllEnvs(); vi.stubEnv("AI_CALLER_BOOKING_V2", "");
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Rollout" }).returning();
    workspaceId = workspace.id;
  });
  afterAll(async () => { vi.unstubAllEnvs(); await closeDatabase(); });

  it("defaults on without entitlements but retains explicit opt-in and rollback", async () => {
    expect(await isBookingV2Enabled(workspaceId)).toBe(true);
    vi.stubEnv("AI_CALLER_BOOKING_V2", "opt-in");
    expect(await isBookingV2Enabled(workspaceId)).toBe(false);
    await db.insert(workspaceEntitlements).values({ workspaceId, key: "BOOKING_ENGINE_VERSION", value: "v2" });
    expect(await isBookingV2Enabled(workspaceId)).toBe(true);
    vi.stubEnv("AI_CALLER_BOOKING_V2", "disabled");
    expect(await isBookingV2Enabled(workspaceId)).toBe(false);
    vi.stubEnv("AI_CALLER_BOOKING_V2", "enabled");
    await db.update(workspaceEntitlements).set({ value: "v1" }).where(eq(workspaceEntitlements.workspaceId, workspaceId));
    expect(await isBookingV2Enabled(workspaceId)).toBe(false);
  });

  async function legacySession() {
    const widget = await ensureWebchatWidget(workspaceId);
    const created = await createOrResumeWebchatSession({ widgetKey: widget.publicKey });
    const [session] = await db.update(webchatSessions).set({ bookingEngineVersion: "v1" })
      .where(eq(webchatSessions.id, created!.sessionId)).returning();
    const turn = await claimWebchatTurn(workspaceId, session.id, randomUUID());
    return { session, turnId: turn.turnId };
  }

  it("does not switch a legacy approval or an in-flight authorized booking", async () => {
    const { session, turnId } = await legacySession();
    expect((await upgradeWebchatBookingSession(session, "yes", turnId)).bookingEngineVersion).toBe("v1");
    await db.insert(pendingAgentActions).values({ workspaceId, conversationId: session.conversationId,
      contactId: session.contactId, type: "BOOK_APPOINTMENT", payload: {}, payloadHash: "test", status: "CONFIRMED" });
    expect((await upgradeWebchatBookingSession(session, "book a cleaning", turnId)).bookingEngineVersion).toBe("v1");
  });

  it("supersedes an unconfirmed legacy preview only for a fresh booking request", async () => {
    const { session, turnId } = await legacySession();
    await db.insert(pendingAgentActions).values({ workspaceId, conversationId: session.conversationId,
      contactId: session.contactId, type: "BOOK_APPOINTMENT", payload: {}, payloadHash: "test", status: "AWAITING_CONFIRMATION" });
    expect((await upgradeWebchatBookingSession(session, "book an office cleaning", turnId)).bookingEngineVersion).toBe("v2");
    expect((await db.select().from(pendingAgentActions))[0].status).toBe("SUPERSEDED");
  });

  it("does not switch while another legacy turn is processing", async () => {
    const { session, turnId } = await legacySession();
    await claimWebchatTurn(workspaceId, session.id, randomUUID());
    expect((await upgradeWebchatBookingSession(session, "book a cleaning", turnId)).bookingEngineVersion).toBe("v1");
  });

  it("keeps an existing durable draft on its engine after rollback", async () => {
    const { session } = await legacySession();
    const ctx = { workspaceId, contactId: session.contactId, conversationId: session.conversationId,
      sessionKey: session.id, channel: "SMS" as const };
    await openBookingDraft(ctx);
    vi.stubEnv("AI_CALLER_BOOKING_V2", "disabled");
    expect(await shouldUseBookingV2(ctx)).toBe(true);
  });
});

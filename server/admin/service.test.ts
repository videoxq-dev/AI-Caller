import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  adminAuditLogs,
  creditLedger,
  creditWallets,
  hostedApiRateCards,
  memberships,
  platformAdmins,
  session,
  user,
  userAdminStates,
  workspacePlans,
  workspaces,
} from "@/db/schema";
import {
  adjustWorkspaceCredits,
  createAdminRateVersion,
  updateAdminUser,
  updateAdminWorkspace,
} from "./service";

const actorId = "platform-admin-test-actor";
const targetId = "platform-admin-test-target";
let workspaceId = "";

describe("platform admin service", () => {
  beforeEach(async () => {
    await db.delete(adminAuditLogs);
    await db.delete(platformAdmins);
    await db.delete(userAdminStates);
    await db.delete(creditLedger);
    await db.delete(creditWallets);
    await db.delete(memberships);
    await db.delete(workspacePlans);
    await db.delete(workspaces);
    await db.delete(session);
    await db.delete(user);
    await db.delete(hostedApiRateCards).where(eq(hostedApiRateCards.provider, "admin-test-provider"));

    await db.insert(user).values([
      { id: actorId, name: "Platform Admin", email: "platform-admin@example.com", emailVerified: true },
      { id: targetId, name: "Target User", email: "target-user@example.com", emailVerified: true },
    ]);
    await db.insert(platformAdmins).values({ userId: actorId, role: "ADMIN", active: true });
    const [workspace] = await db.insert(workspaces).values({ name: "Admin Service Workspace" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: actorId, role: "OWNER" });
    await db.insert(workspacePlans).values({ workspaceId, planId: "GROWTH", source: "TEST" });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("blocks a Personal downgrade while a sub-user occupies a seat", async () => {
    await db.insert(memberships).values({ workspaceId, userId: targetId, role: "STAFF" });

    await expect(updateAdminWorkspace({
      actorUserId: actorId,
      workspaceId,
      planId: "PERSONAL",
    })).rejects.toMatchObject({ code: "PLAN_DOWNGRADE_BLOCKED", status: 409 });

    await db.delete(memberships).where(eq(memberships.userId, targetId));
    await expect(updateAdminWorkspace({
      actorUserId: actorId,
      workspaceId,
      planId: "PERSONAL",
    })).resolves.toBeUndefined();

    const [assigned] = await db.select().from(workspacePlans).where(eq(workspacePlans.workspaceId, workspaceId));
    expect(assigned.planId).toBe("PERSONAL");
    expect((await db.select().from(adminAuditLogs)).at(-1)).toMatchObject({
      action: "WORKSPACE_UPDATED",
      targetType: "WORKSPACE",
      targetId: workspaceId,
    });
  });

  it("applies an audited credit adjustment atomically", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 100 });

    await expect(adjustWorkspaceCredits({
      actorUserId: actorId,
      workspaceId,
      amount: -25,
      reason: "Correct duplicate grant",
    })).resolves.toEqual({ balance: 75 });

    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const [ledger] = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    const [audit] = await db.select().from(adminAuditLogs);
    expect(wallet.balance).toBe(75);
    expect(ledger).toMatchObject({
      type: "ADJUSTMENT",
      amount: -25,
      balanceAfter: 75,
      referenceType: "ADMIN_AUDIT",
      referenceId: audit.id,
    });
    expect(audit).toMatchObject({
      actorUserId: actorId,
      action: "CREDITS_ADJUSTED",
      targetId: workspaceId,
    });
  });

  it("suspends a user and revokes their active sessions", async () => {
    await db.insert(session).values({
      id: "admin-test-session",
      userId: targetId,
      token: "admin-test-session-token",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await updateAdminUser({
      actorUserId: actorId,
      userId: targetId,
      status: "SUSPENDED",
      suspensionReason: "Abuse review",
    });

    expect(await db.select().from(session).where(eq(session.userId, targetId))).toHaveLength(0);
    expect((await db.select().from(userAdminStates).where(eq(userAdminStates.userId, targetId)))[0]).toMatchObject({
      status: "SUSPENDED",
      reason: "Abuse review",
      updatedByUserId: actorId,
    });
  });

  it("creates immutable rate versions and closes the prior effective interval", async () => {
    const firstAt = new Date("2026-09-01T00:00:00.000Z");
    const secondAt = new Date("2026-10-01T00:00:00.000Z");

    const first = await createAdminRateVersion({
      actorUserId: actorId,
      capability: "SMS",
      provider: "admin-test-provider",
      model: "",
      unit: "SMS_SEGMENT",
      costMicros: 9000,
      unitsPerCost: 1,
      targetMarginBps: 5500,
      effectiveFrom: firstAt,
    });
    const second = await createAdminRateVersion({
      actorUserId: actorId,
      capability: "SMS",
      provider: "admin-test-provider",
      model: "",
      unit: "SMS_SEGMENT",
      costMicros: 10000,
      unitsPerCost: 1,
      targetMarginBps: 5500,
      effectiveFrom: secondAt,
    });

    const rows = await db.select().from(hostedApiRateCards)
      .where(eq(hostedApiRateCards.provider, "admin-test-provider"));
    const storedFirst = rows.find((row) => row.id === first.id);
    const storedSecond = rows.find((row) => row.id === second.id);
    expect(storedFirst?.effectiveTo?.toISOString()).toBe(secondAt.toISOString());
    expect(storedSecond?.effectiveTo).toBeNull();
    expect((await db.select().from(adminAuditLogs)).filter((row) => row.action === "HOSTED_RATE_VERSION_CREATED")).toHaveLength(2);
  });
});

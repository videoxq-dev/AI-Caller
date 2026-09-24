import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { commerceEvents, licenses, memberships, user, workspaceEntitlements, workspaces } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { processCommerceEvent } from "./service";
import type { NormalizedPurchaseEvent } from "./types";

const createdWorkspaces: string[] = [];
const createdUsers: string[] = [];
const eventIds: string[] = [];

function event(type: string, receipt: string, buyerEmail: string): NormalizedPurchaseEvent {
  const externalEventId = randomUUID();
  eventIds.push(externalEventId);
  return {
    source: "JVZOO",
    externalEventId,
    externalPurchaseId: receipt,
    eventType: type,
    productId: "revocation-core-product",
    customerEmail: buyerEmail,
    customerName: "Refund Coverage Test",
    purchasedAt: new Date(),
    raw: {},
  };
}

async function fixture() {
  const id = randomUUID();
  const email = "revocation-" + id + "@example.com";
  await db.insert(user).values({ id, name: "Refund Coverage Test", email, emailVerified: true });
  createdUsers.push(id);
  const [workspace] = await db.insert(workspaces).values({ name: "Refund Coverage Business" }).returning();
  createdWorkspaces.push(workspace.id);
  await db.insert(memberships).values({ workspaceId: workspace.id, userId: id, role: "OWNER" });
  const receipts = [randomUUID(), randomUUID()];
  await db.insert(licenses).values(receipts.map((receipt) => ({
    workspaceId: workspace.id,
    purchaserUserId: id,
    source: "JVZOO" as const,
    externalPurchaseId: receipt,
    productCode: "CORE",
    status: "ACTIVE" as const,
    purchasedAt: new Date(),
  })));
  await db.insert(workspaceEntitlements).values({
    workspaceId: workspace.id, key: "core_access", value: true,
  });
  return { workspaceId: workspace.id, email, receipts };
}

describe("Core license revocation coverage", () => {
  beforeEach(() => {
    vi.stubEnv("JVZOO_CORE_PRODUCT_IDS", "revocation-core-product");
    resetEnvForTests();
  });

  afterEach(async () => {
    for (const id of eventIds) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    eventIds.length = 0;
    for (const id of createdWorkspaces) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    createdWorkspaces.length = 0;
    for (const id of createdUsers) await db.delete(user).where(eq(user.id, id));
    createdUsers.length = 0;
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("does not suspend a business or remove Core access while another Core receipt remains active", async () => {
    const { workspaceId, email, receipts } = await fixture();
    const first = await processCommerceEvent(event("RFND", receipts[0], email));
    expect(first).toMatchObject({
      duplicate: false,
      result: { workspaceId, coreAccessRetained: true },
    });
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [entitlement] = await db.select().from(workspaceEntitlements)
      .where(eq(workspaceEntitlements.workspaceId, workspaceId));
    expect(workspace.status).toBe("ACTIVE");
    expect(entitlement.value).toBe(true);
  });

  it("suspends only after the final Core receipt is revoked and restores the same buyer on reinstatement", async () => {
    const { workspaceId, email, receipts } = await fixture();
    await processCommerceEvent(event("CGBK", receipts[0], email));
    const cancelled = await processCommerceEvent(event("CANCEL-REBILL", receipts[1], email));
    expect(cancelled).toMatchObject({
      result: { workspaceId, coreAccessRetained: false },
    });
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [entitlement] = await db.select().from(workspaceEntitlements)
      .where(eq(workspaceEntitlements.workspaceId, workspaceId));
    expect(workspace.status).toBe("SUSPENDED");
    expect(entitlement.value).toBe(false);

    const restored = await processCommerceEvent(event("UNCANCEL-REBILL", receipts[1], email));
    expect(restored).toMatchObject({
      result: { workspaceId },
    });
    const [activeWorkspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [activeEntitlement] = await db.select().from(workspaceEntitlements)
      .where(eq(workspaceEntitlements.workspaceId, workspaceId));
    expect(activeWorkspace.status).toBe("ACTIVE");
    expect(activeEntitlement.value).toBe(true);
  });

  it("serializes simultaneous revocations of the final two active Core receipts", async () => {
    const { workspaceId, email, receipts } = await fixture();
    const results = await Promise.all([
      processCommerceEvent(event("RFND", receipts[0], email)),
      processCommerceEvent(event("RFND", receipts[1], email)),
    ]);
    expect(results.every((result) => result.duplicate === false)).toBe(true);
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [entitlement] = await db.select().from(workspaceEntitlements)
      .where(eq(workspaceEntitlements.workspaceId, workspaceId));
    expect(workspace.status).toBe("SUSPENDED");
    expect(entitlement.value).toBe(false);
  });
});

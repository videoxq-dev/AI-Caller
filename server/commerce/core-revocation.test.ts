import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { commerceEvents, licenses, memberships, user, workspaceEntitlements, workspaces } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { processCommerceEvent } from "./service";

const ownedIds: string[] = [];
const actorIds: string[] = [];
const eventIds: string[] = [];

async function business() {
  const buyerId = randomUUID();
  const email = "core-reconcile-" + buyerId + "@example.com";
  actorIds.push(buyerId);
  await db.insert(user).values({ id: buyerId, name: "License Buyer", email, emailVerified: true });
  const [workspace] = await db.insert(workspaces).values({ name: "Active License Business" }).returning();
  ownedIds.push(workspace.id);
  await db.insert(memberships).values({ userId: buyerId, workspaceId: workspace.id, role: "OWNER" });
  await db.insert(workspaceEntitlements).values({ workspaceId: workspace.id, key: "core_access", value: true });
  return workspace.id;
}

async function purchase(workspaceId: string) {
  const id = randomUUID();
  const [row] = await db.insert(licenses).values({
    workspaceId,
    purchaserUserId: actorIds.at(-1),
    source: "JVZOO",
    externalPurchaseId: id,
    productCode: "CORE",
    status: "ACTIVE",
    purchasedAt: new Date(),
  }).returning();
  return row;
}

async function providerEvent(purchaseId: string, eventType: string) {
  const id = randomUUID();
  eventIds.push(id);
  return processCommerceEvent({
    source: "JVZOO",
    externalEventId: id,
    externalPurchaseId: purchaseId,
    eventType,
    productId: "core-reconcile-sku",
    customerEmail: "ignored-for-revocation@example.com",
    customerName: "License Buyer",
    purchasedAt: new Date(),
    raw: { test: true },
  });
}

async function state(workspaceId: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const [access] = await db.select().from(workspaceEntitlements).where(and(
    eq(workspaceEntitlements.workspaceId, workspaceId),
    eq(workspaceEntitlements.key, "core_access"),
  ));
  return { status: workspace.status, coreAccess: access.value };
}

describe("Core purchase revocation", () => {
  beforeEach(() => {
    vi.stubEnv("JVZOO_CORE_PRODUCT_IDS", "core-reconcile-sku");
    resetEnvForTests();
  });

  afterEach(async () => {
    for (const id of eventIds) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    eventIds.length = 0;
    for (const id of ownedIds) await db.delete(workspaces).where(eq(workspaces.id, id));
    ownedIds.length = 0;
    for (const id of actorIds) await db.delete(user).where(eq(user.id, id));
    actorIds.length = 0;
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("preserves Core access when only one of two valid Core receipts is refunded", async () => {
    const workspaceId = await business();
    const a = await purchase(workspaceId);
    const b = await purchase(workspaceId);

    const result = await providerEvent(a.externalPurchaseId, "RFND");
    expect(result).toMatchObject({ duplicate: false, result: { workspaceId, licenseId: a.id } });
    expect(await state(workspaceId)).toEqual({ status: "ACTIVE", coreAccess: true });
    const [revoked] = await db.select().from(licenses).where(eq(licenses.id, a.id));
    const [remaining] = await db.select().from(licenses).where(eq(licenses.id, b.id));
    expect(revoked.status).toBe("REFUNDED");
    expect(remaining.status).toBe("ACTIVE");
  });

  it("revokes access when the last Core receipt is cancelled for rebilling", async () => {
    const workspaceId = await business();
    const a = await purchase(workspaceId);
    const b = await purchase(workspaceId);
    await providerEvent(a.externalPurchaseId, "RFND");
    const cancelled = await providerEvent(b.externalPurchaseId, "CANCEL-REBILL");

    expect(cancelled).toMatchObject({
      duplicate: false,
      result: { ignored: false, cancellationRecorded: true },
    });
    expect(await state(workspaceId)).toEqual({ status: "SUSPENDED", coreAccess: false });
    const [last] = await db.select().from(licenses).where(eq(licenses.id, b.id));
    expect(last.status).toBe("CANCELLED");
  });

  it("suspends a lone Core receipt on chargeback", async () => {
    const workspaceId = await business();
    const only = await purchase(workspaceId);
    await providerEvent(only.externalPurchaseId, "CGBK");

    expect(await state(workspaceId)).toEqual({ status: "SUSPENDED", coreAccess: false });
    const [row] = await db.select().from(licenses).where(eq(licenses.id, only.id));
    expect(row.status).toBe("CHARGEBACK");
  });

  it("retains Core access when another active manual Core license belongs to the same business", async () => {
    const workspaceId = await business();
    const purchased = await purchase(workspaceId);
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: actorIds.at(-1),
      source: "MANUAL",
      externalPurchaseId: randomUUID(),
      productCode: "CORE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
    await providerEvent(purchased.externalPurchaseId, "RFND");
    expect(await state(workspaceId)).toEqual({ status: "ACTIVE", coreAccess: true });
  });
});

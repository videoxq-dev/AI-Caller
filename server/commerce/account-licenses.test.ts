import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { commerceEvents, licenses, memberships, user, workspaces } from "@/db/schema";
import { activateManualCoreLicense, processCommerceEvent } from "./service";
import { resetEnvForTests } from "@/server/env";
import { getFunnelAccountSummary, summarizeFunnelAccountLicenses, type PurchaserLicense } from "./account-licenses";

const users: string[] = [];
const workspacesToRemove: string[] = [];
const eventIds: string[] = [];

async function buyer(name: string) {
  const id = randomUUID();
  await db.insert(user).values({
    id,
    name,
    email: "funnel-" + id + "@example.com",
    emailVerified: true,
  });
  users.push(id);
  return id;
}

async function ownedWorkspace(userId: string) {
  const [workspace] = await db.insert(workspaces).values({ name: "Funnel Business" }).returning();
  workspacesToRemove.push(workspace.id);
  await db.insert(memberships).values({ workspaceId: workspace.id, userId, role: "OWNER" });
  return workspace.id;
}

async function license(userId: string, workspaceId: string, productCode: string, status: PurchaserLicense["status"]) {
  return db.insert(licenses).values({
    workspaceId,
    purchaserUserId: userId,
    source: "MANUAL",
    externalPurchaseId: randomUUID(),
    productCode,
    status,
    purchasedAt: new Date(),
  }).returning();
}

describe("purchaser-owned commercial licenses", () => {
  afterEach(async () => {
    for (const id of eventIds) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    eventIds.length = 0;
    vi.unstubAllEnvs();
    resetEnvForTests();
    for (const id of workspacesToRemove) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    workspacesToRemove.length = 0;
    for (const id of users) {
      await db.delete(user).where(eq(user.id, id));
    }
    users.length = 0;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("reports no commercial capacity without an active purchase", () => {
    expect(summarizeFunnelAccountLicenses([])).toMatchObject({
      activeProducts: [], businessLimit: 0,
    });
  });

  it("does not count inactive, unknown or non-capacity products towards business slots", () => {
    const id = randomUUID();
    const make = (productCode: string, status: PurchaserLicense["status"]): PurchaserLicense => ({
      id: randomUUID(),
      workspaceId: id,
      productCode,
      status,
      purchasedAt: new Date(),
    });
    expect(summarizeFunnelAccountLicenses([
      make("CORE", "ACTIVE"),
      make("UNLIMITED", "REFUNDED"),
      make("AGENCY_100", "CHARGEBACK"),
      make("PERFORMANCE", "ACTIVE"),
      make("WHITELABEL", "ACTIVE"),
      make("OTHER", "ACTIVE"),
    ])).toMatchObject({
      businessLimit: 1,
      activeProducts: ["CORE", "PERFORMANCE", "WHITELABEL"],
    });
    expect(summarizeFunnelAccountLicenses([
      make("CORE", "ACTIVE"),
      make("AGENCY_50", "ACTIVE"),
      make("AGENCY_100", "ACTIVE"),
    ]).businessLimit).toBe(101);
  });

  it("isolates buyer licenses even when buyers share a workspace membership", async () => {
    const first = await buyer("First Buyer");
    const second = await buyer("Second Buyer");
    const firstWorkspace = await ownedWorkspace(first);
    const secondWorkspace = await ownedWorkspace(second);
    await db.insert(memberships).values({ workspaceId: firstWorkspace, userId: second, role: "STAFF" });
    await license(first, firstWorkspace, "CORE", "ACTIVE");
    await license(first, firstWorkspace, "UNLIMITED", "ACTIVE");
    await license(second, secondWorkspace, "CORE", "REFUNDED");

    expect(await getFunnelAccountSummary(first)).toMatchObject({
      activeProducts: ["CORE", "UNLIMITED"],
      businessLimit: 2,
    });
    expect(await getFunnelAccountSummary(second)).toMatchObject({
      activeProducts: [],
      businessLimit: 0,
    });
  });

  it("ties a real Core purchase to the buyer, never an older staff workspace", async () => {
    vi.stubEnv("JVZOO_CORE_PRODUCT_IDS", "funnel-account-core");
    resetEnvForTests();
    const buyerId = await buyer("Purchased Account");
    const partnerId = await buyer("Host Business");
    const partnerWorkspace = await ownedWorkspace(partnerId);
    await db.insert(memberships).values({ workspaceId: partnerWorkspace, userId: buyerId, role: "STAFF" });
    const purchasedWorkspace = await ownedWorkspace(buyerId);
    const id = randomUUID();
    eventIds.push(id);
    const event = {
      source: "JVZOO" as const,
      externalEventId: id,
      externalPurchaseId: id,
      eventType: "SALE",
      productId: "funnel-account-core",
      customerEmail: "funnel-" + buyerId + "@example.com",
      customerName: "Purchased Account",
      purchasedAt: new Date(),
      raw: {},
    };
    const result = await processCommerceEvent(event);
    expect(result).toMatchObject({
      duplicate: false,
      result: { workspaceId: purchasedWorkspace },
    });
    const [assigned] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, id));
    expect(assigned).toMatchObject({
      workspaceId: purchasedWorkspace,
      purchaserUserId: buyerId,
      productCode: "CORE",
      status: "ACTIVE",
    });
    expect(await getFunnelAccountSummary(buyerId)).toMatchObject({
      activeProducts: ["CORE"], businessLimit: 1,
    });
    expect((await getFunnelAccountSummary(partnerId)).businessLimit).toBe(0);
  });

  it("rejects receipt reuse by a different buyer without moving credits or workspace access", async () => {
    vi.stubEnv("JVZOO_CORE_PRODUCT_IDS", "funnel-account-core");
    resetEnvForTests();
    const first = await buyer("Original Buyer");
    const other = await buyer("Different Buyer");
    const firstWorkspace = await ownedWorkspace(first);
    const otherWorkspace = await ownedWorkspace(other);
    const receipt = randomUUID();
    await db.insert(licenses).values({
      workspaceId: firstWorkspace,
      purchaserUserId: first,
      source: "JVZOO",
      externalPurchaseId: receipt,
      productCode: "CORE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
    const id = randomUUID();
    eventIds.push(id);
    const attempt = {
      source: "JVZOO" as const,
      externalEventId: id,
      externalPurchaseId: receipt,
      eventType: "BILL",
      productId: "funnel-account-core",
      customerEmail: "funnel-" + other + "@example.com",
      customerName: "Different Buyer",
      purchasedAt: new Date(),
      raw: {},
    };
    await expect(processCommerceEvent(attempt)).rejects.toMatchObject({
      code: "PURCHASE_OWNERSHIP_CONFLICT",
      status: 409,
    });
    const [assigned] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt));
    expect(assigned).toMatchObject({ purchaserUserId: first, workspaceId: firstWorkspace });
    expect((await getFunnelAccountSummary(other)).businessLimit).toBe(0);
    const otherWorkspaceLicenses = await db.select().from(licenses).where(eq(licenses.workspaceId, otherWorkspace));
    expect(otherWorkspaceLicenses).toHaveLength(0);
  });

  it("replays a legitimate repeat receipt into its original business without double credits", async () => {
    vi.stubEnv("JVZOO_CORE_PRODUCT_IDS", "funnel-account-core");
    resetEnvForTests();
    const ownerId = await buyer("Repeat Buyer");
    const workspaceId = await ownedWorkspace(ownerId);
    const receipt = randomUUID();
    const makeEvent = (eventType: string) => {
      const id = randomUUID();
      eventIds.push(id);
      return {
        source: "JVZOO" as const,
        externalEventId: id,
        externalPurchaseId: receipt,
        eventType,
        productId: "funnel-account-core",
        customerEmail: "funnel-" + ownerId + "@example.com",
        customerName: "Repeat Buyer",
        purchasedAt: new Date(),
        raw: {},
      };
    };
    const first = await processCommerceEvent(makeEvent("SALE"));
    const second = await processCommerceEvent(makeEvent("BILL"));
    expect(first).toMatchObject({ result: { workspaceId } });
    expect(second).toMatchObject({ result: { workspaceId } });
    expect((second.result as { balance: number }).balance).toBe(
      (first.result as { balance: number }).balance,
    );
    expect((await getFunnelAccountSummary(ownerId)).licenses).toHaveLength(1);
  });

  it("associates manual Core activation with the sole owner and grants credits once", async () => {
    const ownerId = await buyer("Manual Buyer");
    const workspaceId = await ownedWorkspace(ownerId);
    const first = await activateManualCoreLicense(workspaceId);
    const second = await activateManualCoreLicense(workspaceId);
    expect(first.license.purchaserUserId).toBe(ownerId);
    expect(second.license.purchaserUserId).toBe(ownerId);
    expect(second.balance).toBe(first.balance);
    expect(await getFunnelAccountSummary(ownerId)).toMatchObject({
      businessLimit: 1,
      activeProducts: ["CORE"],
    });
  });

  it("does not guess a purchaser for a manually activated multi-owner workspace", async () => {
    const first = await buyer("Co-owner A");
    const second = await buyer("Co-owner B");
    const workspaceId = await ownedWorkspace(first);
    await db.insert(memberships).values({ workspaceId, userId: second, role: "OWNER" });
    const activation = await activateManualCoreLicense(workspaceId);
    expect(activation.license.purchaserUserId).toBeNull();
    expect((await getFunnelAccountSummary(first)).businessLimit).toBe(0);
    expect((await getFunnelAccountSummary(second)).businessLimit).toBe(0);
  });
});

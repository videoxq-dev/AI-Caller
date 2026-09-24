import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { licenses, memberships, user, workspaces } from "@/db/schema";
import { activateManualCoreLicense } from "./service";
import { getFunnelAccountSummary, summarizeFunnelAccountLicenses, type PurchaserLicense } from "./account-licenses";

const users: string[] = [];
const workspacesToRemove: string[] = [];

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
    ]).businessLimit).toBe(100);
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
      businessLimit: 10,
    });
    expect(await getFunnelAccountSummary(second)).toMatchObject({
      activeProducts: [],
      businessLimit: 0,
    });
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

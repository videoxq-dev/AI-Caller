import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { licenses, memberships, user, workspaceCommercialOwners, workspacePlans, workspaces } from "@/db/schema";
import { getContactCapacity } from "./contact-capacity";
import { getWorkspaceIntegrationEntitlements } from "./workspace-entitlements";
import { getWorkspaceSeatUsage } from "@/server/billing/plans";
import { createWorkspaceForUser } from "@/server/auth/workspace-repository";

const users: string[] = [];
const workspacesToDelete: string[] = [];

async function buyer() {
  const id = randomUUID();
  users.push(id);
  await db.insert(user).values({ id, name: "Commercial Buyer", email: id + "@example.com", emailVerified: true });
  return id;
}

async function business(purchaser: string, kind: "PRIMARY" | "ADDITIONAL") {
  const [row] = await db.insert(workspaces).values({ name: kind }).returning();
  workspacesToDelete.push(row.id);
  await db.insert(memberships).values({ workspaceId: row.id, userId: purchaser, role: "OWNER" });
  await db.insert(workspaceCommercialOwners).values({
    workspaceId: row.id, purchaserUserId: purchaser, kind,
  });
  await db.insert(workspacePlans).values({ workspaceId: row.id, planId: "PERSONAL", source: "TEST" });
  return row.id;
}

async function grant(purchaser: string, original: string, code: string) {
  const [row] = await db.insert(licenses).values({
    workspaceId: original, purchaserUserId: purchaser, source: "MANUAL",
    externalPurchaseId: randomUUID(), productCode: code, status: "ACTIVE", purchasedAt: new Date(),
  }).returning();
  return row;
}

describe("F12-B Agency clients do not inherit the purchaser's premium business features", () => {
  afterEach(async () => {
    for (const id of workspacesToDelete.splice(0)) await db.delete(workspaces).where(eq(workspaces.id, id));
    for (const id of users.splice(0)) await db.delete(user).where(eq(user.id, id));
  });
  afterAll(async () => closeDatabase());

  it("gives Agency clients Core caps/seats even when their purchaser has Unlimited and Performance", async () => {
    const purchaser = await buyer();
    const primary = await business(purchaser, "PRIMARY");
    await grant(purchaser, primary, "CORE");
    await grant(purchaser, primary, "AGENCY_50");
    await grant(purchaser, primary, "UNLIMITED");
    await grant(purchaser, primary, "PERFORMANCE");
    await grant(purchaser, primary, "WHITELABEL");
    const client = await business(purchaser, "ADDITIONAL");
    const delegatedOwner = await buyer();
    await db.insert(memberships).values({ workspaceId: client, userId: delegatedOwner, role: "OWNER" });

    expect(await getContactCapacity(primary)).toMatchObject({ limit: null, package: "UNLIMITED" });
    expect(await getWorkspaceSeatUsage(primary)).toMatchObject({
      commercialSeatPackage: "UNLIMITED", plan: { subUserLimit: 5 },
    });
    expect(await getContactCapacity(client)).toMatchObject({ limit: 500, package: null });
    expect(await getWorkspaceSeatUsage(client)).toMatchObject({
      commercialSeatPackage: null, plan: { subUserLimit: 0 },
    });
    expect(await getWorkspaceIntegrationEntitlements(client)).toMatchObject({
      purchaserUserId: purchaser, externalCalendar: false, performanceAutomations: false,
      whitelabelEligible: true, nonCalendarByopEnabled: false,
    });
  });

  it("records Agency client origin at provisioning instead of guessing from a future-dated receipt", async () => {
    const purchaser = await buyer();
    const primary = await business(purchaser, "PRIMARY");
    await grant(purchaser, primary, "CORE");
    await grant(purchaser, primary, "UNLIMITED");
    const agency = await grant(purchaser, primary, "AGENCY_50");
    // A provider's purchasedAt is not the moment our app provisioned the
    // client; timestamp comparisons cannot be used as the permanent policy.
    await db.update(licenses).set({ purchasedAt: new Date(Date.now() + 86_400_000) })
      .where(eq(licenses.id, agency.id));
    const client = await createWorkspaceForUser(purchaser, "Future receipt client");
    workspacesToDelete.push(client.workspaceId);
    const [origin] = await db.select().from(workspaceCommercialOwners)
      .where(eq(workspaceCommercialOwners.workspaceId, client.workspaceId));
    expect(origin.provisioningSource).toBe("AGENCY");
    expect(await getContactCapacity(client.workspaceId)).toMatchObject({ limit: 500 });
    expect(await getWorkspaceSeatUsage(client.workspaceId)).toMatchObject({ commercialSeatPackage: null });
    expect(await getWorkspaceIntegrationEntitlements(client.workspaceId)).toMatchObject({
      externalCalendar: false, performanceAutomations: false,
    });
  });

  it("retains a client's Core boundary after the purchaser refunds Agency", async () => {
    const purchaser = await buyer();
    const primary = await business(purchaser, "PRIMARY");
    const agency = await grant(purchaser, primary, "AGENCY_100");
    await grant(purchaser, primary, "CORE");
    await grant(purchaser, primary, "UNLIMITED");
    await grant(purchaser, primary, "WHITELABEL");
    const client = await business(purchaser, "ADDITIONAL");
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, agency.id));
    expect(await getContactCapacity(client)).toMatchObject({ limit: 500 });
    expect(await getWorkspaceSeatUsage(client)).toMatchObject({
      commercialSeatPackage: null, plan: { subUserLimit: 0 },
    });
    expect((await getWorkspaceIntegrationEntitlements(client)).whitelabelEligible).toBe(false);
  });

  it("preserves Unlimited on the buyer's additional business created BEFORE purchasing Agency", async () => {
    const purchaser = await buyer();
    const primary = await business(purchaser, "PRIMARY");
    await grant(purchaser, primary, "CORE");
    await grant(purchaser, primary, "UNLIMITED");
    const secondOwned = await business(purchaser, "ADDITIONAL");
    await grant(purchaser, primary, "AGENCY_50");
    expect(await getContactCapacity(secondOwned)).toMatchObject({ limit: null });
    expect(await getWorkspaceSeatUsage(secondOwned)).toMatchObject({
      commercialSeatPackage: "UNLIMITED", plan: { subUserLimit: 5 },
    });
  });
});

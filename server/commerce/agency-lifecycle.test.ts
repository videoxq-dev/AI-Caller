import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { licenses, memberships, user, workspaces } from "@/db/schema";
import { createWorkspaceForUser, getOwnedWorkspaceCapacity } from "@/server/auth/workspace-repository";
import { resetEnvForTests } from "@/server/env";
import { reconcileAgencyReceipt } from "./agency-lifecycle";
import type { NormalizedPurchaseEvent } from "./types";

let buyerId = "";
let workspaceId = "";
const buyerEmail = "agency-lifecycle-buyer@example.com";
const workspaceIds: string[] = [];

function event(
  type: string,
  receipt: string,
  sku: "AGENCY_50" | "AGENCY_100" = "AGENCY_50",
  email = buyerEmail,
): NormalizedPurchaseEvent {
  return {
    source: "JVZOO",
    externalEventId: randomUUID(),
    externalPurchaseId: receipt,
    eventType: type,
    productId: sku === "AGENCY_50" ? "agency-50-product" : "agency-100-product",
    customerEmail: email,
    customerName: "Agency Buyer",
    purchasedAt: new Date(),
    raw: { scenario: type, sku },
  };
}

async function addLegacyOwnedWorkspaces(count: number) {
  const rows = await db.insert(workspaces)
    .values(Array.from({ length: count }, (_, index) => ({ name: `Existing Client ${index + 1}` })))
    .returning({ id: workspaces.id });
  workspaceIds.push(...rows.map((row) => row.id));
  await db.insert(memberships).values(rows.map((row) => ({
    workspaceId: row.id,
    userId: buyerId,
    role: "OWNER" as const,
  })));
}

describe("Agency purchase lifecycle", () => {
  beforeEach(async () => {
    vi.stubEnv("JVZOO_AGENCY_50_PRODUCT_IDS", "agency-50-product");
    vi.stubEnv("JVZOO_AGENCY_100_PRODUCT_IDS", "agency-100-product");
    resetEnvForTests();

    buyerId = randomUUID();
    await db.insert(user).values({
      id: buyerId,
      name: "Agency Buyer",
      email: buyerEmail,
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Agency Original Business" }).returning();
    workspaceId = workspace.id;
    workspaceIds.push(workspaceId);
    await db.insert(memberships).values({ workspaceId, userId: buyerId, role: "OWNER" });
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: buyerId,
      source: "JVZOO",
      externalPurchaseId: "agency-core-receipt",
      productCode: "CORE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
  });

  afterEach(async () => {
    for (const id of workspaceIds.splice(0)) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await db.delete(user).where(eq(user.id, buyerId));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("activates Agency 50 on the original Core business without creating client workspaces", async () => {
    const receipt = "agency-50-sale";
    const result = await reconcileAgencyReceipt(event("SALE", receipt));
    expect(result).toMatchObject({
      ignored: false,
      workspaceId,
      productCode: "AGENCY_50",
      status: "ACTIVE",
    });
    const rows = await db.select().from(memberships).where(eq(memberships.userId, buyerId));
    expect(rows).toHaveLength(1);
    const [license] = await db.select().from(licenses).where(and(
      eq(licenses.externalPurchaseId, receipt),
      eq(licenses.productCode, "AGENCY_50"),
    ));
    expect(license).toMatchObject({
      purchaserUserId: buyerId,
      workspaceId,
      status: "ACTIVE",
    });
    expect(await getOwnedWorkspaceCapacity(buyerId)).toMatchObject({
      ownedBusinesses: 1,
      businessLimit: 51,
      agencyClientLimit: 50,
      agencyClientsUsed: 0,
      agencyClientsAvailable: 50,
    });
  });

  it("activates Agency 100 as 100 client slots plus the original business", async () => {
    await reconcileAgencyReceipt(event("SALE", "agency-100-sale", "AGENCY_100"));
    expect(await getOwnedWorkspaceCapacity(buyerId)).toMatchObject({
      ownedBusinesses: 1,
      businessLimit: 101,
      agencyClientLimit: 100,
      agencyClientsAvailable: 100,
    });
  });

  it("requires the purchaser to have an active owned Core business", async () => {
    await db.update(licenses).set({ status: "REFUNDED" })
      .where(eq(licenses.externalPurchaseId, "agency-core-receipt"));
    await expect(reconcileAgencyReceipt(event("SALE", "agency-no-core")))
      .rejects.toMatchObject({ code: "FUNNEL_CORE_PURCHASE_REQUIRED", status: 409 });

    await expect(reconcileAgencyReceipt(event(
      "SALE",
      "agency-unknown-buyer",
      "AGENCY_50",
      "missing-agency-buyer@example.com",
    ))).rejects.toMatchObject({ code: "FUNNEL_CORE_PURCHASE_REQUIRED", status: 409 });
  });

  it("binds a receipt permanently to its original buyer and Agency SKU", async () => {
    const receipt = "agency-bound-receipt";
    await reconcileAgencyReceipt(event("SALE", receipt));
    await expect(reconcileAgencyReceipt(event("BILL", receipt, "AGENCY_50", "stranger@example.com")))
      .rejects.toMatchObject({ code: "PURCHASE_OWNERSHIP_CONFLICT", status: 409 });
    await expect(reconcileAgencyReceipt(event("BILL", receipt, "AGENCY_100")))
      .rejects.toMatchObject({ code: "PURCHASE_OWNERSHIP_CONFLICT", status: 409 });
    expect(await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt)))
      .toHaveLength(1);
  });

  it("cancels access and only explicit uncancellation restores the receipt", async () => {
    const receipt = "agency-cancel-resume";
    await reconcileAgencyReceipt(event("SALE", receipt));
    await reconcileAgencyReceipt(event("CANCEL-REBILL", receipt));
    expect((await getOwnedWorkspaceCapacity(buyerId)).agencyClientLimit).toBeNull();
    expect(await reconcileAgencyReceipt(event("SALE", receipt)))
      .toMatchObject({ ignored: true, reason: "REVOKED_PURCHASE" });
    await reconcileAgencyReceipt(event("UNCANCEL-REBILL", receipt));
    await reconcileAgencyReceipt(event("UNCANCEL-REBILL", receipt));
    expect((await getOwnedWorkspaceCapacity(buyerId)).agencyClientLimit).toBe(50);
    const [license] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt));
    expect(license.status).toBe("ACTIVE");
  });

  it("never revives a refunded or charged-back Agency receipt", async () => {
    const receipt = "agency-refunded";
    await reconcileAgencyReceipt(event("SALE", receipt));
    await reconcileAgencyReceipt(event("RFND", receipt));
    expect((await getOwnedWorkspaceCapacity(buyerId)).agencyClientLimit).toBeNull();
    expect(await reconcileAgencyReceipt(event("SALE", receipt)))
      .toMatchObject({ ignored: true, reason: "REVOKED_PURCHASE" });
    expect(await reconcileAgencyReceipt(event("UNCANCEL-REBILL", receipt)))
      .toMatchObject({ ignored: true, reason: "REVOKED_PURCHASE" });
  });

  it("falls back from Agency 100 to active Agency 50 without deleting over-cap workspaces", async () => {
    await reconcileAgencyReceipt(event("SALE", "agency-50-kept", "AGENCY_50"));
    await reconcileAgencyReceipt(event("SALE", "agency-100-refunded", "AGENCY_100"));
    await addLegacyOwnedWorkspaces(60);
    expect(await getOwnedWorkspaceCapacity(buyerId)).toMatchObject({
      ownedBusinesses: 61,
      businessLimit: 151,
      agencyClientLimit: 150,
      agencyClientsUsed: 60,
      agencyClientsAvailable: 90,
    });

    await reconcileAgencyReceipt(event("RFND", "agency-100-refunded", "AGENCY_100"));
    expect(await getOwnedWorkspaceCapacity(buyerId)).toMatchObject({
      ownedBusinesses: 61,
      businessLimit: 51,
      availableBusinesses: 0,
      agencyClientLimit: 50,
      agencyClientsUsed: 60,
      agencyClientsAvailable: 0,
    });
    expect(await db.select().from(memberships).where(eq(memberships.userId, buyerId)))
      .toHaveLength(61);
    await expect(createWorkspaceForUser(buyerId, "Over-cap client"))
      .rejects.toMatchObject({ code: "WORKSPACE_LIMIT_REACHED", status: 403 });
  });

  it("stacks independent receipts for the same Agency SKU", async () => {
    await reconcileAgencyReceipt(event("SALE", "agency-50-first", "AGENCY_50"));
    await reconcileAgencyReceipt(event("SALE", "agency-50-second", "AGENCY_50"));
    expect(await getOwnedWorkspaceCapacity(buyerId)).toMatchObject({
      businessLimit: 101,
      agencyClientLimit: 100,
      agencyClientsAvailable: 100,
    });

    await reconcileAgencyReceipt(event("RFND", "agency-50-first", "AGENCY_50"));
    expect(await getOwnedWorkspaceCapacity(buyerId)).toMatchObject({
      businessLimit: 51,
      agencyClientLimit: 50,
      agencyClientsAvailable: 50,
    });
  });

  it("keeps an out-of-order reversal retryable until the matching sale exists", async () => {
    const receipt = "agency-late-sale";
    await expect(reconcileAgencyReceipt(event("RFND", receipt)))
      .rejects.toMatchObject({ code: "LICENSE_NOT_FOUND", status: 503 });
    await reconcileAgencyReceipt(event("SALE", receipt));
    await reconcileAgencyReceipt(event("RFND", receipt));
    const [license] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt));
    expect(license.status).toBe("REFUNDED");
  });

  it("serializes simultaneous reversals and never downgrades chargeback to cancellation", async () => {
    const receipt = "agency-concurrent-reversal";
    await reconcileAgencyReceipt(event("SALE", receipt));
    await Promise.all([
      reconcileAgencyReceipt(event("RFND", receipt)),
      reconcileAgencyReceipt(event("CGBK", receipt)),
    ]);
    await reconcileAgencyReceipt(event("CANCEL-REBILL", receipt));
    const [license] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt));
    expect(license.status).toBe("CHARGEBACK");
  });
});

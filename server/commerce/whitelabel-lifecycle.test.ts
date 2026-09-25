import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { commerceEvents, licenses, memberships, user, workspaceCommercialOwners, workspaces } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { getFunnelAccountSummary } from "./account-licenses";
import { processCommerceEvent } from "./service";
import { reconcileWhitelabelReceipt } from "./whitelabel-lifecycle";
import type { NormalizedPurchaseEvent } from "./types";

const buyerEmail = "whitelabel-lifecycle@example.com";
let buyerId = "";
let originalId = "";
const eventIds: string[] = [];

function event(type: string, receipt: string, email = buyerEmail, eventId = randomUUID()): NormalizedPurchaseEvent {
  eventIds.push(eventId);
  return {
    source: "JVZOO", externalEventId: eventId, externalPurchaseId: receipt,
    eventType: type, productId: "whitelabel-product", customerEmail: email,
    customerName: "Whitelabel Purchaser", purchasedAt: new Date(), raw: { type },
  };
}

async function grant(code: string, receipt = randomUUID()) {
  await db.insert(licenses).values({
    workspaceId: originalId, purchaserUserId: buyerId, source: "JVZOO",
    externalPurchaseId: receipt, productCode: code, status: "ACTIVE", purchasedAt: new Date(),
  });
  return receipt;
}

async function effective() {
  return (await getFunnelAccountSummary(buyerId)).effectiveWhitelabel;
}

describe("F12-A Whitelabel receipt lifecycle (internal only; live ingress gated)", () => {
  beforeEach(async () => {
    vi.stubEnv("JVZOO_WHITELABEL_PRODUCT_IDS", "whitelabel-product");
    resetEnvForTests();
    buyerId = randomUUID();
    await db.insert(user).values({ id: buyerId, name: "Whitelabel Purchaser", email: buyerEmail, emailVerified: true });
    const [workspace] = await db.insert(workspaces).values({ name: "Original Business" }).returning();
    originalId = workspace.id;
    await db.insert(memberships).values({ workspaceId: originalId, userId: buyerId, role: "OWNER" });
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: originalId, purchaserUserId: buyerId, kind: "PRIMARY",
    });
    await grant("CORE", "whitelabel-core");
  });

  afterEach(async () => {
    for (const id of eventIds.splice(0)) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    await db.delete(workspaces).where(eq(workspaces.id, originalId));
    await db.delete(user).where(eq(user.id, buyerId));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });
  afterAll(async () => closeDatabase());

  it("records Whitelabel without Agency but never activates its commercial feature", async () => {
    const outcome = await reconcileWhitelabelReceipt(event("SALE", "wl-before-agency"));
    expect(outcome).toMatchObject({ ignored: false, workspaceId: originalId, status: "ACTIVE" });
    expect(await effective()).toBe(false);
    await grant("AGENCY_50");
    expect(await effective()).toBe(true);
  });

  it("does not create businesses, grant credits, or increase Agency capacity", async () => {
    await grant("AGENCY_50");
    const before = await getFunnelAccountSummary(buyerId);
    await reconcileWhitelabelReceipt(event("SALE", "wl-no-capacity"));
    const after = await getFunnelAccountSummary(buyerId);
    expect(after).toMatchObject({ effectiveWhitelabel: true, businessLimit: before.businessLimit, agencyClientLimit: before.agencyClientLimit });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, originalId))).toHaveLength(1);
    expect(await db.select().from(memberships).where(eq(memberships.userId, buyerId))).toHaveLength(1);
  });

  it("makes activation depend on Core, Agency, and Whitelabel from the same buyer", async () => {
    await grant("AGENCY_100", "wl-agency");
    await reconcileWhitelabelReceipt(event("SALE", "wl-dependencies"));
    expect(await effective()).toBe(true);
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.externalPurchaseId, "wl-agency"));
    expect(await effective()).toBe(false);
    await grant("AGENCY_50");
    expect(await effective()).toBe(true);
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.externalPurchaseId, "whitelabel-core"));
    expect(await effective()).toBe(false);
  });

  it("binds receipt and SKU to original purchaser, never a delegated client", async () => {
    await grant("AGENCY_50");
    await reconcileWhitelabelReceipt(event("SALE", "wl-ownership"));
    await expect(reconcileWhitelabelReceipt(event("BILL", "wl-ownership", "another@example.com")))
      .rejects.toMatchObject({ code: "PURCHASE_OWNERSHIP_CONFLICT", status: 409 });
    await expect(reconcileWhitelabelReceipt(event("SALE", "whitelabel-core")))
      .rejects.toMatchObject({ code: "PURCHASE_OWNERSHIP_CONFLICT", status: 409 });
    expect((await db.select().from(licenses).where(eq(licenses.externalPurchaseId, "wl-ownership")))[0])
      .toMatchObject({ purchaserUserId: buyerId, workspaceId: originalId, productCode: "WHITELABEL" });
  });

  it("cannot start a new Whitelabel receipt without the buyer's active Core purchase", async () => {
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.externalPurchaseId, "whitelabel-core"));
    await expect(reconcileWhitelabelReceipt(event("SALE", "wl-no-core")))
      .rejects.toMatchObject({ code: "FUNNEL_CORE_PURCHASE_REQUIRED" });
    expect(await db.select().from(licenses).where(eq(licenses.externalPurchaseId, "wl-no-core"))).toHaveLength(0);
  });

  it("does not mistake a delegated client OWNER for the commercial purchaser", async () => {
    await grant("AGENCY_50");
    const delegatedId = randomUUID();
    await db.insert(user).values({ id: delegatedId, name: "Client", email: "client-" + delegatedId + "@example.com", emailVerified: true });
    try {
      await db.insert(memberships).values({ workspaceId: originalId, userId: delegatedId, role: "OWNER" });
      await reconcileWhitelabelReceipt(event("SALE", "wl-two-owners"));
      expect(await effective()).toBe(true);
      expect((await db.select().from(licenses).where(eq(licenses.externalPurchaseId, "wl-two-owners")))[0].purchaserUserId).toBe(buyerId);
    } finally {
      await db.delete(user).where(eq(user.id, delegatedId));
    }
  });

  it("cancels and only explicitly reinstates a cancelled Whitelabel receipt", async () => {
    await grant("AGENCY_50");
    const receipt = "wl-cancelled";
    await reconcileWhitelabelReceipt(event("SALE", receipt));
    await reconcileWhitelabelReceipt(event("CANCEL-REBILL", receipt));
    expect(await effective()).toBe(false);
    expect(await reconcileWhitelabelReceipt(event("BILL", receipt))).toMatchObject({ ignored: true, reason: "REVOKED_PURCHASE" });
    await reconcileWhitelabelReceipt(event("UNCANCEL-REBILL", receipt));
    expect(await effective()).toBe(true);
  });

  it("does not revive refunds or chargebacks and never downgrades a chargeback", async () => {
    await grant("AGENCY_50");
    const receipt = "wl-terminal";
    await reconcileWhitelabelReceipt(event("SALE", receipt));
    await Promise.all([
      reconcileWhitelabelReceipt(event("RFND", receipt)),
      reconcileWhitelabelReceipt(event("CGBK", receipt)),
    ]);
    await reconcileWhitelabelReceipt(event("CANCEL-REBILL", receipt));
    expect((await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt)))[0].status).toBe("CHARGEBACK");
    expect(await effective()).toBe(false);
    expect(await reconcileWhitelabelReceipt(event("UNCANCEL-REBILL", receipt)))
      .toMatchObject({ ignored: true, reason: "REVOKED_PURCHASE" });
  });

  it("leaves a reversal-before-sale retryable and accepts it after the sale", async () => {
    const receipt = "wl-out-of-order";
    await expect(reconcileWhitelabelReceipt(event("RFND", receipt)))
      .rejects.toMatchObject({ code: "LICENSE_NOT_FOUND", status: 503 });
    await reconcileWhitelabelReceipt(event("SALE", receipt));
    await reconcileWhitelabelReceipt(event("RFND", receipt));
    expect((await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt)))[0].status).toBe("REFUNDED");
  });

  it("preserves Agency and Core when Whitelabel is refunded", async () => {
    await grant("AGENCY_50", "wl-agency-survives");
    const receipt = "wl-isolated-refund";
    await reconcileWhitelabelReceipt(event("SALE", receipt));
    await reconcileWhitelabelReceipt(event("RFND", receipt));
    expect(await effective()).toBe(false);
    expect((await db.select().from(licenses).where(and(eq(licenses.productCode, "CORE"), eq(licenses.purchaserUserId, buyerId)))).every(x => x.status === "ACTIVE")).toBe(true);
    expect((await db.select().from(licenses).where(eq(licenses.externalPurchaseId, "wl-agency-survives")))[0].status).toBe("ACTIVE");
    expect((await db.select().from(workspaces).where(eq(workspaces.id, originalId)))[0].status).toBe("ACTIVE");
  });

  it("leaves public JVZoo ingress closed until the branded/domain/provider offer is accepted", async () => {
    const inbound = event("SALE", "wl-gated-ingress");
    await expect(processCommerceEvent(inbound))
      .rejects.toMatchObject({ code: "FUNNEL_OFFER_NOT_READY", status: 503 });
    expect(await db.select().from(licenses).where(eq(licenses.externalPurchaseId, inbound.externalPurchaseId)))
      .toHaveLength(0);
  });
});

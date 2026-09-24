import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { creditLedger, creditWallets, licenses, memberships, user, workspaces } from "@/db/schema";
import { debitCredits } from "@/server/credits/service";
import { resetEnvForTests } from "@/server/env";
import { reconcileUnlimitedReceipt } from "./unlimited-lifecycle";
import type { NormalizedPurchaseEvent } from "./types";

let buyerId = "";
let workspaceId = "";
const buyerEmail = "unlimited-lifecycle-buyer@example.com";

function event(type: string, receipt: string, email = buyerEmail): NormalizedPurchaseEvent {
  return {
    source: "JVZOO",
    externalEventId: randomUUID(),
    externalPurchaseId: receipt,
    eventType: type,
    productId: "unlimited-lifecycle-product",
    customerEmail: email,
    customerName: "Unlimited Buyer",
    purchasedAt: new Date(),
    raw: { scenario: type },
  };
}

describe("Unlimited receipt lifecycle (not connected to live ingress)", () => {
  beforeEach(async () => {
    vi.stubEnv("JVZOO_UNLIMITED_PRODUCT_IDS", "unlimited-lifecycle-product");
    resetEnvForTests();
    buyerId = randomUUID();
    await db.insert(user).values({
      id: buyerId, name: "Unlimited Buyer", email: buyerEmail, emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Core Buyer Business" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: buyerId, role: "OWNER" });
    await db.insert(licenses).values({
      workspaceId, purchaserUserId: buyerId, source: "JVZOO",
      externalPurchaseId: "core-existing-receipt", productCode: "CORE",
      status: "ACTIVE", purchasedAt: new Date(),
    });
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(user).where(eq(user.id, buyerId));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("attaches a verified upgrade to its Core buyer without creating a second workspace", async () => {
    const receipt = "unlimited-owner-upgrade";
    const first = await reconcileUnlimitedReceipt(event("SALE", receipt));
    const repeat = await reconcileUnlimitedReceipt(event("BILL", receipt));
    expect(first).toMatchObject({ ignored: false, workspaceId, balance: 15_000 });
    expect(repeat).toMatchObject({ ignored: false, workspaceId });
    const upgrade = await db.select().from(licenses).where(and(
      eq(licenses.externalPurchaseId, receipt), eq(licenses.productCode, "UNLIMITED"),
    ));
    expect(upgrade).toHaveLength(1);
    expect(upgrade[0]).toMatchObject({
      purchaserUserId: buyerId, workspaceId, status: "ACTIVE",
    });
    expect(await db.select().from(workspaces)).toHaveLength(1);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.referenceType, "LICENSE_BONUS")))
      .toHaveLength(1);
    expect((await db.select().from(creditWallets))[0].balance).toBe(15_000);
  });

  it("rejects an unknown or non-Core purchaser without creating an account or receipt", async () => {
    await expect(reconcileUnlimitedReceipt(event("SALE", "unknown-buyer", "unknown-oto@example.com")))
      .rejects.toMatchObject({ code: "FUNNEL_CORE_PURCHASE_REQUIRED", status: 409 });
    await db.update(licenses).set({ status: "REFUNDED" })
      .where(eq(licenses.externalPurchaseId, "core-existing-receipt"));
    await expect(reconcileUnlimitedReceipt(event("SALE", "revoked-core")))
      .rejects.toMatchObject({ code: "FUNNEL_CORE_PURCHASE_REQUIRED", status: 409 });
    expect(await db.select().from(licenses).where(eq(licenses.productCode, "UNLIMITED")))
      .toHaveLength(0);
  });

  it("does not let another email claim or revoke an existing upgrade", async () => {
    const receipt = "unlimited-owner-bound";
    await reconcileUnlimitedReceipt(event("SALE", receipt));
    await expect(reconcileUnlimitedReceipt(event("BILL", receipt, "stranger@example.com")))
      .rejects.toMatchObject({ code: "PURCHASE_OWNERSHIP_CONFLICT", status: 409 });
    await expect(reconcileUnlimitedReceipt(event("RFND", receipt, "stranger@example.com")))
      .rejects.toMatchObject({ code: "PURCHASE_OWNERSHIP_CONFLICT", status: 409 });
    const [license] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt));
    expect(license.status).toBe("ACTIVE");
  });

  it("reverses only its bonus on refund after usage and leaves Core access untouched", async () => {
    const receipt = "unlimited-spent-refund";
    await reconcileUnlimitedReceipt(event("SALE", receipt));
    await debitCredits(workspaceId, 8, {
      reason: "Delivered hosted AI", referenceType: "ORCHESTRATOR_CALL",
      referenceId: "spent-unlimited",
    });
    await reconcileUnlimitedReceipt(event("RFND", receipt));
    await reconcileUnlimitedReceipt(event("CGBK", receipt));
    expect((await db.select().from(creditWallets))[0].balance).toBe(-8);
    expect(await db.select().from(creditLedger)
      .where(eq(creditLedger.referenceType, "LICENSE_BONUS_REVERSAL"))).toHaveLength(1);
    expect((await db.select().from(workspaces))[0].status).toBe("ACTIVE");
    const [core] = await db.select().from(licenses).where(eq(licenses.productCode, "CORE"));
    expect(core.status).toBe("ACTIVE");
    const [upgrade] = await db.select().from(licenses).where(eq(licenses.productCode, "UNLIMITED"));
    expect(upgrade.status).toBe("CHARGEBACK");
    expect(await reconcileUnlimitedReceipt(event("SALE", receipt)))
      .toMatchObject({ ignored: true, reason: "REVOKED_PURCHASE" });
  });

  it("keeps bonus on cancellation and does not double-grant on uncancellation", async () => {
    const receipt = "unlimited-cancel-resume";
    await reconcileUnlimitedReceipt(event("SALE", receipt));
    await reconcileUnlimitedReceipt(event("CANCEL-REBILL", receipt));
    expect((await db.select().from(creditWallets))[0].balance).toBe(15_000);
    expect(await reconcileUnlimitedReceipt(event("SALE", receipt)))
      .toMatchObject({ ignored: true, reason: "REVOKED_PURCHASE" });
    await reconcileUnlimitedReceipt(event("UNCANCEL-REBILL", receipt));
    await reconcileUnlimitedReceipt(event("UNCANCEL-REBILL", receipt));
    expect((await db.select().from(creditWallets))[0].balance).toBe(15_000);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.referenceType, "LICENSE_BONUS")))
      .toHaveLength(1);
    expect(await db.select().from(creditLedger)
      .where(eq(creditLedger.referenceType, "LICENSE_BONUS_REVERSAL"))).toHaveLength(0);
  });

  it("leaves an out-of-order refund retryable until the matching sale is recorded", async () => {
    const receipt = "unlimited-late-sale";
    await expect(reconcileUnlimitedReceipt(event("RFND", receipt)))
      .rejects.toMatchObject({ code: "LICENSE_NOT_FOUND", status: 503 });
    await reconcileUnlimitedReceipt(event("SALE", receipt));
    await reconcileUnlimitedReceipt(event("RFND", receipt));
    expect((await db.select().from(creditWallets))[0].balance).toBe(0);
    const [upgrade] = await db.select().from(licenses).where(eq(licenses.productCode, "UNLIMITED"));
    expect(upgrade.status).toBe("REFUNDED");
  });

  it("serializes simultaneous refunds and never changes a chargeback to cancellation", async () => {
    const receipt = "unlimited-concurrent-reversal";
    await reconcileUnlimitedReceipt(event("SALE", receipt));
    await Promise.all([
      reconcileUnlimitedReceipt(event("RFND", receipt)),
      reconcileUnlimitedReceipt(event("CGBK", receipt)),
    ]);
    await reconcileUnlimitedReceipt(event("CANCEL-REBILL", receipt));
    expect((await db.select().from(creditWallets))[0].balance).toBe(0);
    const [upgrade] = await db.select().from(licenses).where(eq(licenses.productCode, "UNLIMITED"));
    expect(upgrade.status).toBe("CHARGEBACK");
    expect(await db.select().from(creditLedger)
      .where(eq(creditLedger.referenceType, "LICENSE_BONUS_REVERSAL"))).toHaveLength(1);
  });
});

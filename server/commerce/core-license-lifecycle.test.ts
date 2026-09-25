import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { commerceEvents, creditLedger, creditWallets, licenses, memberships, user, workspaceEntitlements, workspaces } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { debitCredits } from "@/server/credits/service";
import { processCommerceEvent } from "./service";
import type { NormalizedPurchaseEvent } from "./types";

const eventIds: string[] = [];
let buyerId = "";
let workspaceId = "";

function purchaseEvent(type: string, receipt: string, email = "funnel-lifecycle@example.com"): NormalizedPurchaseEvent {
  const externalEventId = randomUUID();
  eventIds.push(externalEventId);
  return {
    source: "JVZOO", externalEventId, externalPurchaseId: receipt,
    eventType: type, productId: "core-lifecycle", customerEmail: email,
    customerName: "Lifecycle Buyer", purchasedAt: new Date(), raw: {},
  };
}

async function coreLicense(receipt: string, source: "JVZOO" | "MANUAL" = "JVZOO") {
  const [license] = await db.insert(licenses).values({
    workspaceId, purchaserUserId: buyerId, source,
    externalPurchaseId: receipt, productCode: "CORE",
    status: "ACTIVE", purchasedAt: new Date(),
  }).returning();
  return license;
}

describe("Core purchase lifecycle", () => {
  beforeEach(async () => {
    vi.stubEnv("JVZOO_CORE_PRODUCT_IDS", "core-lifecycle");
    resetEnvForTests();
    buyerId = randomUUID();
    await db.insert(user).values({
      id: buyerId, name: "Lifecycle Buyer",
      email: "funnel-lifecycle@example.com", emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Core Lifecycle Business" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: buyerId, role: "OWNER" });
  });

  afterEach(async () => {
    for (const id of eventIds) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    eventIds.length = 0;
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(user).where(eq(user.id, buyerId));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("reverses only the refunded receipt's promotional grant after usage, once", async () => {
    const receipt = "credit-refund-spent";
    const first = await processCommerceEvent(purchaseEvent("SALE", receipt));
    expect(first.duplicate).toBe(false);
    const licenseId = (first.result as { licenseId: string }).licenseId;
    const [grant] = await db.select().from(creditLedger).where(and(
      eq(creditLedger.workspaceId, workspaceId),
      eq(creditLedger.type, "GRANT"),
      eq(creditLedger.referenceId, licenseId),
    ));
    expect(grant.amount).toBeGreaterThan(7);

    await debitCredits(workspaceId, 7, {
      reason: "Delivered hosted AI",
      referenceType: "ORCHESTRATOR_CALL",
      referenceId: "core-credit-refund-spent",
    });
    await processCommerceEvent(purchaseEvent("RFND", receipt));
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    expect(wallet.balance).toBe(-7);
    await processCommerceEvent(purchaseEvent("CGBK", receipt));
    expect((await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)))[0].balance)
      .toBe(-7);
    const reversed = await db.select().from(creditLedger).where(and(
      eq(creditLedger.workspaceId, workspaceId),
      eq(creditLedger.referenceType, "LICENSE_GRANT_REVERSAL"),
      eq(creditLedger.referenceId, licenseId),
    ));
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ type: "ADJUSTMENT", amount: -grant.amount });
    const delayed = await processCommerceEvent(purchaseEvent("SALE", receipt));
    expect(delayed).toMatchObject({ result: { ignored: true, reason: "REVOKED_PURCHASE" } });
    expect((await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)))[0].balance)
      .toBe(-7);
  });

  it("leaves a separate paid Core grant intact when another receipt is refunded", async () => {
    const first = await processCommerceEvent(purchaseEvent("SALE", "refunded-license-a"));
    const second = await processCommerceEvent(purchaseEvent("SALE", "active-license-b"));
    const eachGrant = (first.result as { balance: number }).balance;
    expect((second.result as { balance: number }).balance).toBe(eachGrant * 2);
    await processCommerceEvent(purchaseEvent("RFND", "refunded-license-a"));

    expect((await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)))[0].balance)
      .toBe(eachGrant);
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status)
      .toBe("ACTIVE");
    const grants = await db.select().from(creditLedger).where(and(
      eq(creditLedger.workspaceId, workspaceId), eq(creditLedger.type, "GRANT"),
    ));
    expect(grants).toHaveLength(2);
  });

  it("retains promotional credits on rebill cancellation and never double-grants on uncancellation", async () => {
    const receipt = "rebill-credit-retained";
    const first = await processCommerceEvent(purchaseEvent("SALE", receipt));
    const original = (first.result as { balance: number }).balance;
    await processCommerceEvent(purchaseEvent("CANCEL-REBILL", receipt));
    expect((await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)))[0].balance)
      .toBe(original);
    await processCommerceEvent(purchaseEvent("UNCANCEL-REBILL", receipt));
    expect((await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)))[0].balance)
      .toBe(original);
    expect(await db.select().from(creditLedger).where(and(
      eq(creditLedger.workspaceId, workspaceId),
      eq(creditLedger.referenceType, "LICENSE_GRANT_REVERSAL"),
    ))).toHaveLength(0);
  });

  it("keeps an active business open when one of two valid Core receipts is refunded", async () => {
    await coreLicense("core-receipt-one");
    await coreLicense("core-receipt-two");
    await processCommerceEvent(purchaseEvent("RFND", "core-receipt-one"));

    const [first] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, "core-receipt-one"));
    expect(first.status).toBe("REFUNDED");
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("ACTIVE");
    const [entitlement] = await db.select().from(workspaceEntitlements)
      .where(and(eq(workspaceEntitlements.workspaceId, workspaceId), eq(workspaceEntitlements.key, "core_access")));
    expect(entitlement.value).toBe(true);

    await processCommerceEvent(purchaseEvent("CGBK", "core-receipt-two"));
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("SUSPENDED");
    const [revoked] = await db.select().from(workspaceEntitlements)
      .where(and(eq(workspaceEntitlements.workspaceId, workspaceId), eq(workspaceEntitlements.key, "core_access")));
    expect(revoked.value).toBe(false);
  });

  it("retains access purchased through a separate manual Core license", async () => {
    await coreLicense("separate-manual-core", "MANUAL");
    await coreLicense("refunded-jvzoo-core");
    await processCommerceEvent(purchaseEvent("RFND", "refunded-jvzoo-core"));
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("ACTIVE");
  });

  it("treats cancellation as a license revocation and restores only on explicit uncancellation", async () => {
    await coreLicense("cancelled-core");
    await processCommerceEvent(purchaseEvent("CANCEL-REBILL", "cancelled-core"));
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("SUSPENDED");
    await processCommerceEvent(purchaseEvent("SALE", "cancelled-core"));
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("SUSPENDED");
    await processCommerceEvent(purchaseEvent("UNCANCEL-REBILL", "cancelled-core"));
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("ACTIVE");
  });

  it("repeats uncancellation safely without a second promotional grant", async () => {
    await coreLicense("uncancel-twice");
    await processCommerceEvent(purchaseEvent("CANCEL-REBILL", "uncancel-twice"));
    const first = await processCommerceEvent(purchaseEvent("UNCANCEL-REBILL", "uncancel-twice"));
    const second = await processCommerceEvent(purchaseEvent("UNCANCEL-REBILL", "uncancel-twice"));
    expect(first).toMatchObject({ duplicate: false, result: { workspaceId } });
    expect(second).toMatchObject({ duplicate: false, result: { workspaceId } });
    expect((first.result as { balance: number }).balance)
      .toBe((second.result as { balance: number }).balance);
    const [license] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, "uncancel-twice"));
    expect(license.status).toBe("ACTIVE");
  });

  it("does not reactivate refunded receipts from delayed sale messages", async () => {
    await coreLicense("refunded-core");
    await processCommerceEvent(purchaseEvent("RFND", "refunded-core"));
    const replay = await processCommerceEvent(purchaseEvent("SALE", "refunded-core"));
    expect(replay).toMatchObject({ result: { ignored: true, reason: "REVOKED_PURCHASE" } });
    const [license] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, "refunded-core"));
    expect(license.status).toBe("REFUNDED");
  });

  it("never downgrades chargeback status to a later refund or cancellation", async () => {
    await coreLicense("charged-back-core");
    await processCommerceEvent(purchaseEvent("CGBK", "charged-back-core"));
    await processCommerceEvent(purchaseEvent("RFND", "charged-back-core"));
    await processCommerceEvent(purchaseEvent("CANCEL-REBILL", "charged-back-core"));
    const [license] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, "charged-back-core"));
    expect(license.status).toBe("CHARGEBACK");
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("SUSPENDED");
    const attempt = await processCommerceEvent(purchaseEvent("UNCANCEL-REBILL", "charged-back-core"));
    expect(attempt).toMatchObject({ result: { ignored: true, reason: "REVOKED_PURCHASE" } });
  });

  it("preserves chargeback precedence when refund and chargeback arrive together", async () => {
    await coreLicense("parallel-terminal-receipt");
    await Promise.all([
      processCommerceEvent(purchaseEvent("RFND", "parallel-terminal-receipt")),
      processCommerceEvent(purchaseEvent("CGBK", "parallel-terminal-receipt")),
    ]);
    const [license] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, "parallel-terminal-receipt"));
    expect(license.status).toBe("CHARGEBACK");
  });

  it("does not discard an out-of-order refund before the corresponding purchase arrives", async () => {
    const earlyRefund = purchaseEvent("RFND", "late-purchase");
    await expect(processCommerceEvent(earlyRefund)).rejects.toMatchObject({
      code: "LICENSE_NOT_FOUND", status: 503,
    });
    const [pending] = await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, earlyRefund.externalEventId));
    expect(pending.status).toBe("FAILED");

    await processCommerceEvent(purchaseEvent("SALE", "late-purchase"));
    const retried = await processCommerceEvent(earlyRefund);
    expect(retried.duplicate).toBe(false);
    const [license] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, "late-purchase"));
    expect(license.status).toBe("REFUNDED");
  });

  it("refuses to revoke a receipt on a mismatched purchaser email", async () => {
    await coreLicense("owner-protected");
    await expect(processCommerceEvent(purchaseEvent("RFND", "owner-protected", "other-buyer@example.com")))
      .rejects.toMatchObject({ code: "PURCHASE_OWNERSHIP_CONFLICT", status: 409 });
    const [license] = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, "owner-protected"));
    expect(license.status).toBe("ACTIVE");
  });

  it("serializes concurrent refunds across separate receipts so the final state is suspended", async () => {
    await coreLicense("concurrent-receipt-one");
    await coreLicense("concurrent-receipt-two");
    const results = await Promise.all([
      processCommerceEvent(purchaseEvent("RFND", "concurrent-receipt-one")),
      processCommerceEvent(purchaseEvent("RFND", "concurrent-receipt-two")),
    ]);
    expect(results).toHaveLength(2);
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status).toBe("SUSPENDED");
  });

  it("blocks an in-flight BILL behind an earlier refund before writing Core access", async () => {
    const receipt = "interleaved-bill-refund";
    await coreLicense(receipt);
    const guard = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await guard.connect();
    await guard.query("BEGIN");
    await guard.query("select pg_advisory_xact_lock(hashtext($1))", ["core-license:" + workspaceId]);

    const waitingCount = async () => {
      // Inspect PostgreSQL's lock table directly rather than relying on the
      // sampled pg_stat_activity query text / wait_event label.
      const result = await guard.query(
        "select count(*)::int AS waiting from pg_locks " +
        "where locktype = 'advisory' and granted = false",
      );
      return result.rows[0].waiting as number;
    };
    const waitFor = async (minimum: number) => {
      // CI sometimes needs more than three seconds to schedule a competing
      // purchase webhook. Keep the lock-based assertion instead of accepting
      // a sequential refund/BILL test that would miss the regression.
      for (let i = 0; i < 400; i++) {
        if (await waitingCount() >= minimum) return true;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return false;
    };

    let refund: ReturnType<typeof processCommerceEvent> | null = null;
    let bill: ReturnType<typeof processCommerceEvent> | null = null;
    let refundWaiting = false;
    let billStarted = false;
    try {
      refund = processCommerceEvent(purchaseEvent("RFND", receipt));
      refundWaiting = await waitFor(1);
      const billEvent = purchaseEvent("BILL", receipt);
      bill = processCommerceEvent(billEvent);
      // Prove that the second IPN entered commerce processing while the
      // refund is blocked. Depending on database row-lock scheduling it may
      // wait on the license UPSERT rather than the advisory lock itself.
      for (let i = 0; i < 100; i++) {
        const observed = await guard.query(
          "select status from commerce_events where source = 'JVZOO' and external_event_id = $1",
          [billEvent.externalEventId],
        );
        if (observed.rows[0]?.status === "RECEIVED") {
          billStarted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    } finally {
      await guard.query("COMMIT");
      await guard.end();
    }
    // Always drain both tasks even if the wait assertions fail.
    const results = await Promise.allSettled([refund, bill].filter((task) => task !== null));
    expect(refundWaiting).toBe(true);
    expect(billStarted).toBe(true);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const [license] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, receipt));
    expect(license.status).toBe("REFUNDED");
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [access] = await db.select().from(workspaceEntitlements).where(and(
      eq(workspaceEntitlements.workspaceId, workspaceId),
      eq(workspaceEntitlements.key, "core_access"),
    ));
    expect(workspace.status).toBe("SUSPENDED");
    expect(access.value).toBe(false);
    expect(results[1].status === "fulfilled" && results[1].value)
      .toMatchObject({ result: { ignored: true, reason: "REVOKED_PURCHASE" } });
  }, 30_000);
});

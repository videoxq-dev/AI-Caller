import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { creditLedger, creditReservations, creditWallets, licenses, workspaces } from "@/db/schema";
import {
  chargeUnavoidableCredits,
  debitCredits,
  grantStarterCredits,
  grantUnlimitedPurchaseCredits,
  reverseStarterCreditsInTx,
  reverseUnlimitedPurchaseCreditsInTx,
  refundCredits,
  releaseCreditReservation,
  reserveCredits,
  settleCreditReservation,
} from "./service";

describe("credits", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(creditReservations);
    await db.delete(creditLedger);
    await db.delete(creditWallets);
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Credits Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("grants starter credits exactly once for a license reference", async () => {
    const first = await grantStarterCredits(workspaceId, "license-test-1");
    const second = await grantStarterCredits(workspaceId, "license-test-1");
    expect(second).toBe(first);

    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(wallet.balance).toBe(first);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("GRANT");
  });

  it("does not lose concurrent starter grants for distinct license references", async () => {
    const first = await grantStarterCredits(workspaceId, "license-concurrent-base");
    const amount = first;
    const results = await Promise.all([
      grantStarterCredits(workspaceId, "license-concurrent-a"),
      grantStarterCredits(workspaceId, "license-concurrent-b"),
    ]);

    expect(results.sort((left, right) => left - right)).toEqual([amount * 2, amount * 3]);
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(wallet.balance).toBe(amount * 3);
    expect(entries.filter((entry) => entry.type === "GRANT")).toHaveLength(3);
  });

  it("grants 15,000 additional credits once for an ACTIVE Unlimited receipt", async () => {
    const [license] = await db.insert(licenses).values({
      workspaceId,
      source: "MANUAL",
      externalPurchaseId: "unlimited-bonus-one",
      productCode: "UNLIMITED",
      status: "ACTIVE",
      purchasedAt: new Date(),
    }).returning();
    const first = await grantUnlimitedPurchaseCredits(workspaceId, license.id);
    const repeated = await grantUnlimitedPurchaseCredits(workspaceId, license.id);
    expect(first).toBe(15_000);
    expect(repeated).toBe(first);
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(wallet.balance).toBe(15_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "GRANT",
      amount: 15_000,
      referenceType: "LICENSE_BONUS",
      referenceId: license.id,
    });
  });

  it("keeps Core starter and Unlimited bonus grants separate on the same business", async () => {
    const [license] = await db.insert(licenses).values({
      workspaceId,
      source: "MANUAL",
      externalPurchaseId: "unlimited-plus-core",
      productCode: "UNLIMITED",
      status: "ACTIVE",
      purchasedAt: new Date(),
    }).returning();
    const starter = await grantStarterCredits(workspaceId, "core-license-id");
    const combined = await grantUnlimitedPurchaseCredits(workspaceId, license.id);
    expect(combined).toBe(starter + 15_000);
    expect(await grantUnlimitedPurchaseCredits(workspaceId, license.id)).toBe(combined);
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.referenceType).sort()).toEqual(["LICENSE", "LICENSE_BONUS"]);
  });

  it("rejects refunded, wrong-SKU and wrong-workspace receipts without granting credits", async () => {
    const [refunded, core] = await db.insert(licenses).values([
      {
        workspaceId, source: "MANUAL", externalPurchaseId: "refunded-unlimited",
        productCode: "UNLIMITED", status: "REFUNDED", purchasedAt: new Date(),
      },
      {
        workspaceId, source: "MANUAL", externalPurchaseId: "core-no-unlimited-bonus",
        productCode: "CORE", status: "ACTIVE", purchasedAt: new Date(),
      },
    ]).returning();
    const [other] = await db.insert(workspaces).values({ name: "Other Credits Workspace" }).returning();
    for (const [targetWorkspace, id] of [
      [workspaceId, refunded.id], [workspaceId, core.id], [other.id, core.id], [other.id, refunded.id],
    ]) {
      await expect(grantUnlimitedPurchaseCredits(targetWorkspace, id))
        .rejects.toMatchObject({ code: "FUNNEL_LICENSE_NOT_ELIGIBLE", status: 409 });
    }
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("does not grant a promotion twice when two workers process the same Unlimited purchase", async () => {
    const [license] = await db.insert(licenses).values({
      workspaceId,
      source: "MANUAL", externalPurchaseId: "concurrent-unlimited-bonus",
      productCode: "UNLIMITED", status: "ACTIVE", purchasedAt: new Date(),
    }).returning();
    const results = await Promise.all([
      grantUnlimitedPurchaseCredits(workspaceId, license.id),
      grantUnlimitedPurchaseCredits(workspaceId, license.id),
    ]);
    expect(results).toEqual([15_000, 15_000]);
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(entries).toHaveLength(1);
    expect((await db.select().from(creditWallets))[0].balance).toBe(15_000);
  });

  it("reverses only the refunded Unlimited bonus, preserving Core and paid credit history", async () => {
    const [license] = await db.insert(licenses).values({
      workspaceId,
      source: "MANUAL",
      externalPurchaseId: "unlimited-refund-credits",
      productCode: "UNLIMITED",
      status: "ACTIVE",
      purchasedAt: new Date(),
    }).returning();
    await grantStarterCredits(workspaceId, "independent-core");
    await grantUnlimitedPurchaseCredits(workspaceId, license.id);
    await refundCredits(workspaceId, 2_000, {
      reason: "Paid hosted credit top-up",
      referenceType: "PAID_TOPUP",
      referenceId: "topup-remains",
    });
    await debitCredits(workspaceId, 17_500, {
      reason: "Delivered hosted AI",
      referenceType: "ORCHESTRATOR_CALL",
      referenceId: "unlimited-spend-remains",
    });
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, license.id));

    const first = await db.transaction((tx) => reverseUnlimitedPurchaseCreditsInTx(tx, workspaceId, license.id));
    const again = await db.transaction((tx) => reverseUnlimitedPurchaseCreditsInTx(tx, workspaceId, license.id));
    expect(first).toBe(-500);
    expect(again).toBe(-500);

    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    expect(wallet.balance).toBe(-500);
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(rows.filter((row) => row.referenceType === "LICENSE_BONUS_REVERSAL")).toMatchObject([{
      type: "ADJUSTMENT",
      referenceId: license.id,
      amount: -15_000,
      balanceAfter: -500,
    }]);
    expect(rows.filter((row) => row.referenceType === "LICENSE")).toHaveLength(1);
    expect(rows.filter((row) => row.referenceType === "PAID_TOPUP")).toHaveLength(1);
    expect(rows.filter((row) => row.referenceType === "ORCHESTRATOR_CALL")).toHaveLength(1);
  });

  it("rejects bonus reversal for an active, cancelled, wrong-SKU or other-business purchase", async () => {
    const [unlimited, core] = await db.insert(licenses).values([
      {
        workspaceId, source: "MANUAL", externalPurchaseId: "unlimited-reversal-ineligible",
        productCode: "UNLIMITED", status: "ACTIVE", purchasedAt: new Date(),
      },
      {
        workspaceId, source: "MANUAL", externalPurchaseId: "core-reversal-ineligible",
        productCode: "CORE", status: "REFUNDED", purchasedAt: new Date(),
      },
    ]).returning();
    await grantUnlimitedPurchaseCredits(workspaceId, unlimited.id);
    const [other] = await db.insert(workspaces).values({ name: "Other Bonus Reversal Business" }).returning();
    const reverse = (targetWorkspace: string, licenseId: string) =>
      db.transaction((tx) => reverseUnlimitedPurchaseCreditsInTx(tx, targetWorkspace, licenseId));
    for (const [targetWorkspace, licenseId] of [
      [workspaceId, unlimited.id], [workspaceId, core.id], [other.id, unlimited.id],
    ]) {
      await expect(reverse(targetWorkspace, licenseId))
        .rejects.toMatchObject({ code: "FUNNEL_LICENSE_NOT_ELIGIBLE", status: 409 });
    }
    await db.update(licenses).set({ status: "CANCELLED" }).where(eq(licenses.id, unlimited.id));
    await expect(reverse(workspaceId, unlimited.id))
      .rejects.toMatchObject({ code: "FUNNEL_LICENSE_NOT_ELIGIBLE", status: 409 });
    expect((await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)))[0].balance)
      .toBe(15_000);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.referenceType, "LICENSE_BONUS_REVERSAL")))
      .toHaveLength(0);
  });

  it("uses historical bonus amount and handles a missing grant without inventing a debit", async () => {
    const [historical, missing] = await db.insert(licenses).values([
      {
        workspaceId, source: "MANUAL", externalPurchaseId: "historical-unlimited-bonus",
        productCode: "UNLIMITED", status: "REFUNDED", purchasedAt: new Date(),
      },
      {
        workspaceId, source: "MANUAL", externalPurchaseId: "no-unlimited-bonus",
        productCode: "UNLIMITED", status: "CHARGEBACK", purchasedAt: new Date(),
      },
    ]).returning();
    await db.insert(creditWallets).values({ workspaceId, balance: 2_500 });
    await db.insert(creditLedger).values({
      workspaceId,
      type: "GRANT",
      amount: 2_500,
      balanceAfter: 2_500,
      reason: "Historical Unlimited promotion",
      referenceType: "LICENSE_BONUS",
      referenceId: historical.id,
    });

    expect(await db.transaction((tx) => reverseUnlimitedPurchaseCreditsInTx(tx, workspaceId, missing.id)))
      .toBeNull();
    expect(await db.transaction((tx) => reverseUnlimitedPurchaseCreditsInTx(tx, workspaceId, historical.id)))
      .toBe(0);
    const [adjustment] = await db.select().from(creditLedger)
      .where(eq(creditLedger.referenceType, "LICENSE_BONUS_REVERSAL"));
    expect(adjustment).toMatchObject({ referenceId: historical.id, amount: -2_500 });
  });

  it("serializes two refund workers so an Unlimited bonus is reversed just once", async () => {
    const [license] = await db.insert(licenses).values({
      workspaceId, source: "MANUAL", externalPurchaseId: "concurrent-unlimited-refund",
      productCode: "UNLIMITED", status: "ACTIVE", purchasedAt: new Date(),
    }).returning();
    await grantUnlimitedPurchaseCredits(workspaceId, license.id);
    await db.update(licenses).set({ status: "CHARGEBACK" }).where(eq(licenses.id, license.id));
    const balances = await Promise.all([
      db.transaction((tx) => reverseUnlimitedPurchaseCreditsInTx(tx, workspaceId, license.id)),
      db.transaction((tx) => reverseUnlimitedPurchaseCreditsInTx(tx, workspaceId, license.id)),
    ]);
    expect(balances).toEqual([0, 0]);
    expect(await db.select().from(creditLedger)
      .where(eq(creditLedger.referenceType, "LICENSE_BONUS_REVERSAL"))).toHaveLength(1);
  });

  it("makes hosted debit and refund references idempotent", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 10 });
    const input = { reason: "Hosted AI", referenceType: "ORCHESTRATOR_CALL", referenceId: "call-1" };

    expect(await debitCredits(workspaceId, 3, input)).toBe(7);
    expect(await debitCredits(workspaceId, 3, input)).toBe(7);
    expect(await refundCredits(workspaceId, 3, { ...input, reason: "Provider failed" })).toBe(10);
    expect(await refundCredits(workspaceId, 3, { ...input, reason: "Provider failed again" })).toBe(10);

    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(wallet.balance).toBe(10);
    expect(entries.map((entry) => entry.type).sort()).toEqual(["DEBIT", "REFUND"]);
  });

  it("reserves wallet capacity without recording usage until settlement", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 20 });
    const reservation = await reserveCredits(workspaceId, 10, {
      referenceType: "ORCHESTRATOR_RESERVATION",
      referenceId: "call-r1",
    });

    let [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    expect(wallet.balance).toBe(10);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId))).toHaveLength(0);

    expect(await settleCreditReservation(workspaceId, reservation.id, 3, {
      reason: "Hosted AI response",
      referenceType: "ORCHESTRATOR_CALL",
      referenceId: "call-r1",
    })).toBe(17);
    expect(await settleCreditReservation(workspaceId, reservation.id, 3, {
      reason: "Hosted AI response",
      referenceType: "ORCHESTRATOR_CALL",
      referenceId: "call-r1",
    })).toBe(17);

    [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(wallet.balance).toBe(17);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "DEBIT", amount: -3, balanceAfter: 17 });
  });

  it("settles provider spend after an expired reservation was released", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 6 });
    const reservation = await reserveCredits(workspaceId, 5, {
      referenceType: "ORCHESTRATOR_RESERVATION",
      referenceId: "call-expired",
    });
    await db.update(creditReservations).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(creditReservations.id, reservation.id));

    // A later wallet operation releases the expired hold before the original provider response arrives.
    await chargeUnavoidableCredits(workspaceId, 2, {
      reason: "Concurrent inbound provider spend",
      referenceType: "SMS_INBOUND_MESSAGE",
      referenceId: "inbound-during-expiry",
    });
    expect((await db.select().from(creditWallets))[0].balance).toBe(4);

    expect(await settleCreditReservation(workspaceId, reservation.id, 3, {
      reason: "Late successful hosted AI response",
      referenceType: "ORCHESTRATOR_CALL",
      referenceId: "call-expired",
    })).toBe(1);

    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(entries.filter((entry) => entry.type === "DEBIT")).toHaveLength(2);
    expect(entries.find((entry) => entry.referenceId === "call-expired")).toMatchObject({
      amount: -3,
      balanceAfter: 1,
    });
  });

  it("releases the full reservation when the provider call fails", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 12 });
    const reservation = await reserveCredits(workspaceId, 8, {
      referenceType: "ORCHESTRATOR_RESERVATION",
      referenceId: "call-r2",
    });

    expect(await releaseCreditReservation(workspaceId, reservation.id)).toBe(12);
    expect(await releaseCreditReservation(workspaceId, reservation.id)).toBe(12);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("settles a prefunded Realtime voice call once and refunds unused credits", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 500 });
    const hold = await reserveCredits(workspaceId, 300, {
      referenceType: "VOICE_REALTIME_HOLD", referenceId: "call-under",
    });
    const charge = {
      reason: "Hosted Realtime inbound voice call",
      referenceType: "VOICE_CALL", referenceId: "call-under",
    };
    expect(await settleCreditReservation(workspaceId, hold.id, 100, charge)).toBe(400);
    expect(await settleCreditReservation(workspaceId, hold.id, 100, charge)).toBe(400);
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "DEBIT", amount: -100 });
    const [reservation] = await db.select().from(creditReservations)
      .where(eq(creditReservations.id, hold.id));
    expect(reservation).toMatchObject({ status: "SETTLED", actualAmount: 100 });
  });

  it("charges unavoidable Realtime voice overage even after held credits are exhausted", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 500 });
    const hold = await reserveCredits(workspaceId, 300, {
      referenceType: "VOICE_REALTIME_HOLD", referenceId: "call-over",
    });
    const charge = {
      reason: "Hosted Realtime inbound voice call",
      referenceType: "VOICE_CALL", referenceId: "call-over",
    };
    expect(await settleCreditReservation(workspaceId, hold.id, 700, charge)).toBe(-200);
    expect(await settleCreditReservation(workspaceId, hold.id, 700, charge)).toBe(-200);
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "DEBIT", amount: -700, balanceAfter: -200,
    });
  });

  it("does not allow ordinary reservations to bypass the Realtime-only overage rule", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 5 });
    const hold = await reserveCredits(workspaceId, 4, {
      referenceType: "ORCHESTRATOR_RESERVATION", referenceId: "call-ordinary",
    });
    await expect(settleCreditReservation(workspaceId, hold.id, 6, {
      reason: "Hosted text AI",
      referenceType: "ORCHESTRATOR_CALL", referenceId: "call-ordinary",
    })).rejects.toThrow("not enough hosted credits");
    expect((await db.select().from(creditWallets))[0].balance).toBe(1);
    expect(await db.select().from(creditLedger)).toHaveLength(0);
  });

  it("records unavoidable provider spend even when it creates a negative balance", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 2 });
    const input = {
      reason: "Hosted inbound SMS",
      referenceType: "SMS_INBOUND_MESSAGE",
      referenceId: "twilio:SM-inbound-1",
    };

    expect(await chargeUnavoidableCredits(workspaceId, 5, input)).toBe(-3);
    expect(await chargeUnavoidableCredits(workspaceId, 5, input)).toBe(-3);

    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(wallet.balance).toBe(-3);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "DEBIT", amount: -5, balanceAfter: -3 });
  });

  it("never lets concurrent hosted debits overspend the wallet", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 10 });
    const results = await Promise.allSettled([
      debitCredits(workspaceId, 6, { reason: "Hosted AI", referenceType: "ORCHESTRATOR_CALL", referenceId: "call-a" }),
      debitCredits(workspaceId, 6, { reason: "Hosted AI", referenceType: "ORCHESTRATOR_CALL", referenceId: "call-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
    expect(wallet.balance).toBe(4);
    expect(entries.filter((entry) => entry.type === "DEBIT")).toHaveLength(1);
  });
  it("reverses the exact original grant once even when the balance is already spent", async () => {
    const granted = await grantStarterCredits(workspaceId, "refunded-license");
    await debitCredits(workspaceId, 7, {
      reason: "Delivered hosted AI", referenceType: "ORCHESTRATOR_CALL", referenceId: "spent-before-refund",
    });

    const first = await db.transaction((tx) => reverseStarterCreditsInTx(tx, workspaceId, "refunded-license"));
    const second = await db.transaction((tx) => reverseStarterCreditsInTx(tx, workspaceId, "refunded-license"));
    expect(granted).toBeGreaterThan(7);
    expect(first).toBe(-7);
    expect(second).toBe(-7);

    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    expect(wallet.balance).toBe(-7);
    const adjustments = await db.select().from(creditLedger).where(and(
      eq(creditLedger.workspaceId, workspaceId),
      eq(creditLedger.referenceType, "LICENSE_GRANT_REVERSAL"),
    ));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({
      type: "ADJUSTMENT", referenceId: "refunded-license", amount: -granted,
    });
  });

  it("does not reverse another license or fabricate a reversal for a missing grant", async () => {
    const firstAmount = await grantStarterCredits(workspaceId, "license-a");
    const withTwoGrants = await grantStarterCredits(workspaceId, "license-b");
    const missing = await db.transaction((tx) => reverseStarterCreditsInTx(tx, workspaceId, "license-no-grant"));
    expect(missing).toBeNull();
    const afterOneRefund = await db.transaction((tx) => reverseStarterCreditsInTx(tx, workspaceId, "license-a"));
    expect(afterOneRefund).toBe(withTwoGrants - firstAmount);
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId));
    expect(wallet.balance).toBe(firstAmount);
  });

  it("uses the historical grant amount rather than the current promotion setting", async () => {
    // Use a known historical-sized grant independent of the configured
    // STARTER_CREDITS value at the time the license is reversed.
    await db.insert(creditWallets).values({ workspaceId, balance: 2500 });
    await db.insert(creditLedger).values({
      workspaceId,
      type: "GRANT",
      amount: 2500,
      balanceAfter: 2500,
      reason: "Starter hosted credits",
      referenceType: "LICENSE",
      referenceId: "historical-license",
    });
    expect(await db.transaction((tx) => reverseStarterCreditsInTx(tx, workspaceId, "historical-license")))
      .toBe(0);
    const [adjustment] = await db.select().from(creditLedger).where(and(
      eq(creditLedger.workspaceId, workspaceId),
      eq(creditLedger.referenceType, "LICENSE_GRANT_REVERSAL"),
    ));
    expect(adjustment.amount).toBe(-2500);
  });

});

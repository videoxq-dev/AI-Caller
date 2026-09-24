import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { creditLedger, creditReservations, creditWallets, workspaces } from "@/db/schema";
import {
  chargeUnavoidableCredits,
  debitCredits,
  grantStarterCredits,
  reverseStarterCreditsInTx,
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

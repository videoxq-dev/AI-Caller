import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { creditLedger, creditReservations, creditWallets, workspaces } from "@/db/schema";
import {
  debitCredits,
  grantStarterCredits,
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
});

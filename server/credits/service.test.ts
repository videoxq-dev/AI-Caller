import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { creditLedger, creditWallets, workspaces } from "@/db/schema";
import { debitCredits, grantStarterCredits, refundCredits } from "./service";

describe("credits", () => {
  let workspaceId = "";

  beforeEach(async () => {
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

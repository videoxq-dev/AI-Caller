import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { creditLedger, creditWallets, workspaces } from "@/db/schema";
import { grantStarterCredits } from "./service";

describe("starter credits", () => {
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
});

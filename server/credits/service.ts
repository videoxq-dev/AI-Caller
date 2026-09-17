import { eq } from "drizzle-orm";
import { db } from "@/db";
import { creditLedger, creditWallets } from "@/db/schema";
import { getEnv } from "@/server/env";

export async function getCreditBalance(workspaceId: string): Promise<number> {
  const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)).limit(1);
  return wallet?.balance ?? 0;
}

export async function grantStarterCredits(workspaceId: string, referenceId: string): Promise<number> {
  const amount = getEnv().STARTER_CREDITS;

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: creditLedger.id, balanceAfter: creditLedger.balanceAfter })
      .from(creditLedger)
      .where(eq(creditLedger.referenceId, referenceId))
      .limit(1);
    if (existing[0]) return existing[0].balanceAfter;

    const [wallet] = await tx
      .insert(creditWallets)
      .values({ workspaceId, balance: 0 })
      .onConflictDoNothing()
      .returning();

    const current = wallet?.balance ?? (await tx.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)).limit(1))[0]?.balance ?? 0;
    const next = current + amount;

    await tx.update(creditWallets).set({ balance: next, updatedAt: new Date() }).where(eq(creditWallets.workspaceId, workspaceId));
    await tx.insert(creditLedger).values({
      workspaceId,
      type: "GRANT",
      amount,
      balanceAfter: next,
      reason: "Starter hosted credits",
      referenceType: "LICENSE",
      referenceId,
    });

    return next;
  });
}

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { creditLedger, creditWallets } from "@/db/schema";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";

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
      .where(and(
        eq(creditLedger.workspaceId, workspaceId),
        eq(creditLedger.type, "GRANT"),
        eq(creditLedger.referenceType, "LICENSE"),
        eq(creditLedger.referenceId, referenceId),
      ))
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

export async function debitCredits(
  workspaceId: string,
  amount: number,
  input: { reason: string; referenceType: string; referenceId: string },
): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Credit debit amount must be a positive integer.");

  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ balanceAfter: creditLedger.balanceAfter })
      .from(creditLedger)
      .where(and(
        eq(creditLedger.workspaceId, workspaceId),
        eq(creditLedger.type, "DEBIT"),
        eq(creditLedger.referenceType, input.referenceType),
        eq(creditLedger.referenceId, input.referenceId),
      ))
      .limit(1);
    if (existing) return existing.balanceAfter;

    const [wallet] = await tx.update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(creditWallets.workspaceId, workspaceId),
        gte(creditWallets.balance, amount),
      ))
      .returning({ balance: creditWallets.balance });

    if (!wallet) {
      throw new AppError("INSUFFICIENT_CREDITS", "There are not enough hosted credits for this AI request.", 402);
    }

    await tx.insert(creditLedger).values({
      workspaceId,
      type: "DEBIT",
      amount: -amount,
      balanceAfter: wallet.balance,
      reason: input.reason,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    });
    return wallet.balance;
  });
}

export async function refundCredits(
  workspaceId: string,
  amount: number,
  input: { reason: string; referenceType: string; referenceId: string },
): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Credit refund amount must be a positive integer.");

  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ balanceAfter: creditLedger.balanceAfter })
      .from(creditLedger)
      .where(and(
        eq(creditLedger.workspaceId, workspaceId),
        eq(creditLedger.type, "REFUND"),
        eq(creditLedger.referenceType, input.referenceType),
        eq(creditLedger.referenceId, input.referenceId),
      ))
      .limit(1);
    if (existing) return existing.balanceAfter;

    const [wallet] = await tx.update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(creditWallets.workspaceId, workspaceId))
      .returning({ balance: creditWallets.balance });
    if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);

    await tx.insert(creditLedger).values({
      workspaceId,
      type: "REFUND",
      amount,
      balanceAfter: wallet.balance,
      reason: input.reason,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    });
    return wallet.balance;
  });
}

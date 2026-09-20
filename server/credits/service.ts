import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { creditLedger, creditReservations, creditWallets } from "@/db/schema";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";

const RESERVATION_TTL_MS = 15 * 60 * 1000;

function positiveInteger(amount: number, label: string) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`${label} must be a positive integer.`);
}

function nonNegativeInteger(amount: number, label: string) {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative integer.`);
}

async function lockWallet(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit-wallet:${workspaceId}`}))`);
}

async function releaseExpiredReservations(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  now: Date,
) {
  const expired = await tx
    .select({ id: creditReservations.id, amount: creditReservations.amount })
    .from(creditReservations)
    .where(and(
      eq(creditReservations.workspaceId, workspaceId),
      eq(creditReservations.status, "ACTIVE"),
      lte(creditReservations.expiresAt, now),
    ));

  if (!expired.length) return;
  const amount = expired.reduce((total, row) => total + row.amount, 0);
  const [wallet] = await tx.update(creditWallets)
    .set({
      balance: sql`${creditWallets.balance} + ${amount}`,
      updatedAt: now,
    })
    .where(eq(creditWallets.workspaceId, workspaceId))
    .returning({ balance: creditWallets.balance });
  if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);

  for (const reservation of expired) {
    await tx.update(creditReservations).set({
      status: "RELEASED",
      actualAmount: 0,
      settledAt: now,
      updatedAt: now,
    }).where(and(
      eq(creditReservations.id, reservation.id),
      eq(creditReservations.status, "ACTIVE"),
    ));
  }
}

export async function getCreditBalance(workspaceId: string): Promise<number> {
  const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)).limit(1);
  return wallet?.balance ?? 0;
}

export async function grantStarterCredits(workspaceId: string, referenceId: string): Promise<number> {
  const amount = getEnv().STARTER_CREDITS;

  return db.transaction(async (tx) => {
    await lockWallet(tx, workspaceId);
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

export async function reserveCredits(
  workspaceId: string,
  amount: number,
  input: { referenceType: string; referenceId: string },
) {
  positiveInteger(amount, "Credit reservation amount");

  return db.transaction(async (tx) => {
    await lockWallet(tx, workspaceId);
    const now = new Date();
    await releaseExpiredReservations(tx, workspaceId, now);

    const [existing] = await tx
      .select()
      .from(creditReservations)
      .where(and(
        eq(creditReservations.workspaceId, workspaceId),
        eq(creditReservations.referenceType, input.referenceType),
        eq(creditReservations.referenceId, input.referenceId),
      ))
      .limit(1);
    if (existing) return existing;

    const [wallet] = await tx.update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} - ${amount}`,
        updatedAt: now,
      })
      .where(and(
        eq(creditWallets.workspaceId, workspaceId),
        gte(creditWallets.balance, amount),
      ))
      .returning({ balance: creditWallets.balance });
    if (!wallet) {
      throw new AppError("INSUFFICIENT_CREDITS", "There are not enough hosted credits for this request.", 402);
    }

    const [reservation] = await tx.insert(creditReservations).values({
      workspaceId,
      amount,
      status: "ACTIVE",
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
    }).returning();
    return reservation;
  });
}

export async function settleCreditReservation(
  workspaceId: string,
  reservationId: string,
  actualAmount: number,
  input: { reason: string; referenceType: string; referenceId: string },
): Promise<number> {
  nonNegativeInteger(actualAmount, "Settled credit amount");

  return db.transaction(async (tx) => {
    await lockWallet(tx, workspaceId);
    const [reservation] = await tx.select().from(creditReservations).where(and(
      eq(creditReservations.workspaceId, workspaceId),
      eq(creditReservations.id, reservationId),
    )).limit(1);
    if (!reservation) throw new AppError("CREDIT_RESERVATION_NOT_FOUND", "Credit reservation not found.", 409);

    if (reservation.status === "SETTLED") {
      const [entry] = await tx.select({ balanceAfter: creditLedger.balanceAfter }).from(creditLedger).where(and(
        eq(creditLedger.workspaceId, workspaceId),
        eq(creditLedger.type, "DEBIT"),
        eq(creditLedger.referenceType, input.referenceType),
        eq(creditLedger.referenceId, input.referenceId),
      )).limit(1);
      if (actualAmount === 0) {
        const [wallet] = await tx.select({ balance: creditWallets.balance }).from(creditWallets)
          .where(eq(creditWallets.workspaceId, workspaceId)).limit(1);
        if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);
        return wallet.balance;
      }
      if (!entry) throw new AppError("CREDIT_SETTLEMENT_INCOMPLETE", "Credit settlement ledger entry is missing.", 409);
      return entry.balanceAfter;
    }
    if (reservation.status === "RELEASED") {
      const [existing] = await tx.select({ balanceAfter: creditLedger.balanceAfter }).from(creditLedger).where(and(
        eq(creditLedger.workspaceId, workspaceId),
        eq(creditLedger.type, "DEBIT"),
        eq(creditLedger.referenceType, input.referenceType),
        eq(creditLedger.referenceId, input.referenceId),
      )).limit(1);
      if (existing) return existing.balanceAfter;

      const [wallet] = await tx.select({ balance: creditWallets.balance }).from(creditWallets)
        .where(eq(creditWallets.workspaceId, workspaceId)).limit(1);
      if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);
      if (actualAmount === 0) {
        await tx.update(creditReservations).set({
          status: "SETTLED",
          actualAmount: 0,
          settledAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(creditReservations.id, reservation.id));
        return wallet.balance;
      }

      const [charged] = await tx.update(creditWallets).set({
        balance: sql`${creditWallets.balance} - ${actualAmount}`,
        updatedAt: new Date(),
      }).where(eq(creditWallets.workspaceId, workspaceId)).returning({ balance: creditWallets.balance });
      if (!charged) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);

      await tx.insert(creditLedger).values({
        workspaceId,
        type: "DEBIT",
        amount: -actualAmount,
        balanceAfter: charged.balance,
        reason: input.reason,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      });
      await tx.update(creditReservations).set({
        status: "SETTLED",
        actualAmount,
        settledAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(creditReservations.id, reservation.id));
      return charged.balance;
    }
    if (reservation.status !== "ACTIVE") {
      throw new AppError("CREDIT_RESERVATION_INVALID", "Credit reservation cannot be settled.", 409);
    }

    const difference = reservation.amount - actualAmount;
    let wallet: { balance: number } | undefined;
    if (difference >= 0) {
      [wallet] = await tx.update(creditWallets)
        .set({
          balance: sql`${creditWallets.balance} + ${difference}`,
          updatedAt: new Date(),
        })
        .where(eq(creditWallets.workspaceId, workspaceId))
        .returning({ balance: creditWallets.balance });
    } else {
      const extra = -difference;
      // The carrier and OpenAI have already performed this call. Actual
      // authoritative usage can exceed a prefunded hold. Never discard that
      // debt or release the hold just because the workspace used its balance
      // elsewhere. This exception is strictly limited to a matching voice
      // hold; every other reservation still requires available funds.
      const unavoidableVoiceOverage =
        reservation.referenceType === "VOICE_REALTIME_HOLD"
        && input.referenceType === "VOICE_CALL"
        && reservation.referenceId === input.referenceId;
      [wallet] = await tx.update(creditWallets)
        .set({
          balance: sql`${creditWallets.balance} - ${extra}`,
          updatedAt: new Date(),
        })
        .where(unavoidableVoiceOverage
          ? eq(creditWallets.workspaceId, workspaceId)
          : and(eq(creditWallets.workspaceId, workspaceId),
            gte(creditWallets.balance, extra)))
        .returning({ balance: creditWallets.balance });
    }
    if (!wallet) {
      throw new AppError("INSUFFICIENT_CREDITS", "There are not enough hosted credits to settle this request.", 402);
    }

    if (actualAmount > 0) {
      await tx.insert(creditLedger).values({
        workspaceId,
        type: "DEBIT",
        amount: -actualAmount,
        balanceAfter: wallet.balance,
        reason: input.reason,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      });
    }

    await tx.update(creditReservations).set({
      status: "SETTLED",
      actualAmount,
      settledAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(creditReservations.id, reservation.id),
      eq(creditReservations.status, "ACTIVE"),
    ));
    return wallet.balance;
  });
}

export async function releaseCreditReservation(
  workspaceId: string,
  reservationId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockWallet(tx, workspaceId);
    const [reservation] = await tx.select().from(creditReservations).where(and(
      eq(creditReservations.workspaceId, workspaceId),
      eq(creditReservations.id, reservationId),
    )).limit(1);
    if (!reservation) throw new AppError("CREDIT_RESERVATION_NOT_FOUND", "Credit reservation not found.", 409);

    if (reservation.status === "RELEASED") {
      const [wallet] = await tx.select({ balance: creditWallets.balance }).from(creditWallets)
        .where(eq(creditWallets.workspaceId, workspaceId)).limit(1);
      if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);
      return wallet.balance;
    }
    if (reservation.status !== "ACTIVE") {
      throw new AppError("CREDIT_RESERVATION_SETTLED", "Settled credit reservations cannot be released.", 409);
    }

    const [wallet] = await tx.update(creditWallets).set({
      balance: sql`${creditWallets.balance} + ${reservation.amount}`,
      updatedAt: new Date(),
    }).where(eq(creditWallets.workspaceId, workspaceId)).returning({ balance: creditWallets.balance });
    if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);

    await tx.update(creditReservations).set({
      status: "RELEASED",
      actualAmount: 0,
      settledAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(creditReservations.id, reservation.id),
      eq(creditReservations.status, "ACTIVE"),
    ));
    return wallet.balance;
  });
}

export async function chargeUnavoidableCredits(
  workspaceId: string,
  amount: number,
  input: { reason: string; referenceType: string; referenceId: string },
): Promise<number> {
  positiveInteger(amount, "Unavoidable credit charge");

  return db.transaction(async (tx) => {
    await lockWallet(tx, workspaceId);
    const now = new Date();
    await releaseExpiredReservations(tx, workspaceId, now);

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

    await tx.insert(creditWallets).values({ workspaceId, balance: 0 }).onConflictDoNothing();
    const [wallet] = await tx.update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} - ${amount}`,
        updatedAt: now,
      })
      .where(eq(creditWallets.workspaceId, workspaceId))
      .returning({ balance: creditWallets.balance });
    if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Hosted credit wallet not found.", 409);

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

export async function debitCredits(
  workspaceId: string,
  amount: number,
  input: { reason: string; referenceType: string; referenceId: string },
): Promise<number> {
  positiveInteger(amount, "Credit debit amount");

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
      throw new AppError("INSUFFICIENT_CREDITS", "There are not enough hosted credits for this request.", 402);
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
  positiveInteger(amount, "Credit refund amount");

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

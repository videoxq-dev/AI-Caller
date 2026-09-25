import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agencyCreditAllocations, agencyCreditPoolLedger, agencyCreditPools,
  creditLedger, creditWallets, licenses, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockPool(tx: Tx, purchaserUserId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agency-pool:${purchaserUserId}`}))`);
}

async function lockWorkspaceWallet(tx: Tx, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit-wallet:${workspaceId}`}))`);
}

async function assertActiveAgency(tx: Tx, purchaserUserId: string) {
  const [license] = await tx.select({ id: licenses.id }).from(licenses).where(and(
    eq(licenses.purchaserUserId, purchaserUserId),
    eq(licenses.status, "ACTIVE"),
    sql`${licenses.productCode} in ('AGENCY_50', 'AGENCY_100')`,
  )).limit(1);
  if (!license) throw new AppError("AGENCY_REQUIRED", "An active Agency purchase is required.", 403);
}

export async function requireAgencyCreditPurchaser(purchaserUserId: string) {
  return db.transaction(async (tx) => {
    await assertActiveAgency(tx, purchaserUserId);
    const [primary] = await tx.select({ workspaceId: workspaceCommercialOwners.workspaceId })
      .from(workspaceCommercialOwners).where(and(
        eq(workspaceCommercialOwners.purchaserUserId, purchaserUserId),
        eq(workspaceCommercialOwners.kind, "PRIMARY"),
      )).limit(1);
    if (!primary) throw new AppError("AGENCY_PRIMARY_WORKSPACE_REQUIRED", "The Agency's original workspace was not found.", 409);
    return primary.workspaceId;
  });
}

/** Called only from the verified Stripe payment transaction; repeat webhooks must not recredit. */
export async function creditAgencyPoolTopupInTx(
  tx: Tx,
  purchaserUserId: string,
  topupId: string,
  amount: number,
) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError("INVALID_CREDIT_AMOUNT", "Credit amount must be a positive integer.", 400);
  }
  await lockPool(tx, purchaserUserId);
  const [existing] = await tx.select({ balanceAfter: agencyCreditPoolLedger.balanceAfter })
    .from(agencyCreditPoolLedger).where(and(
      eq(agencyCreditPoolLedger.purchaserUserId, purchaserUserId),
      eq(agencyCreditPoolLedger.type, "PURCHASE"),
      eq(agencyCreditPoolLedger.referenceType, "STRIPE_TOPUP"),
      eq(agencyCreditPoolLedger.referenceId, topupId),
    )).limit(1);
  if (existing) return existing.balanceAfter;

  await tx.insert(agencyCreditPools).values({ purchaserUserId, balance: 0 }).onConflictDoNothing();
  const [pool] = await tx.update(agencyCreditPools).set({
    balance: sql`${agencyCreditPools.balance} + ${amount}`, updatedAt: new Date(),
  }).where(eq(agencyCreditPools.purchaserUserId, purchaserUserId)).returning({ balance: agencyCreditPools.balance });
  if (!pool) throw new AppError("AGENCY_POOL_NOT_FOUND", "Agency credit pool could not be created.", 409);
  await tx.insert(agencyCreditPoolLedger).values({
    purchaserUserId, type: "PURCHASE", amount, balanceAfter: pool.balance,
    reason: "Verified Stripe Agency credit purchase",
    referenceType: "STRIPE_TOPUP", referenceId: topupId,
  });
  return pool.balance;
}

/**
 * A payment dispute affects the purchasing Agency, not any recipient workspace.
 * Allocated/consumed client credits are never silently clawed back. Pool debt
 * is recorded and must be covered before any further allocation.
 */
export async function adjustAgencyPoolForPaymentInTx(
  tx: Tx, purchaserUserId: string, eventId: string, amount: number,
) {
  if (!Number.isSafeInteger(amount) || amount === 0) return;
  await lockPool(tx, purchaserUserId);
  const [existing] = await tx.select({ id: agencyCreditPoolLedger.id })
    .from(agencyCreditPoolLedger).where(and(
      eq(agencyCreditPoolLedger.purchaserUserId, purchaserUserId),
      eq(agencyCreditPoolLedger.type, "ADJUSTMENT"),
      eq(agencyCreditPoolLedger.referenceType, "STRIPE_EVENT"),
      eq(agencyCreditPoolLedger.referenceId, eventId),
    )).limit(1);
  if (existing) return;
  await tx.insert(agencyCreditPools).values({ purchaserUserId, balance: 0 }).onConflictDoNothing();
  const [pool] = await tx.update(agencyCreditPools).set({
    balance: sql`${agencyCreditPools.balance} + ${amount}`,
    updatedAt: new Date(),
  }).where(eq(agencyCreditPools.purchaserUserId, purchaserUserId)).returning({ balance: agencyCreditPools.balance });
  if (!pool) throw new AppError("AGENCY_POOL_NOT_FOUND", "Agency pool was not found.", 409);
  await tx.insert(agencyCreditPoolLedger).values({
    purchaserUserId, type: "ADJUSTMENT", amount, balanceAfter: pool.balance,
    reason: amount < 0 ? "Payment provider loss against Agency purchase" : "Payment provider restored Agency purchase",
    referenceType: "STRIPE_EVENT", referenceId: eventId,
  });
}

export async function allocateAgencyCredits(input: {
  purchaserUserId: string;
  workspaceId: string;
  amount: number;
  idempotencyKey: string;
}) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 1_000_000_000) {
    throw new AppError("INVALID_CREDIT_AMOUNT", "Enter a positive credit amount.", 400);
  }
  return db.transaction(async (tx) => {
    await lockPool(tx, input.purchaserUserId);
    const [previous] = await tx.select().from(agencyCreditAllocations).where(and(
      eq(agencyCreditAllocations.purchaserUserId, input.purchaserUserId),
      eq(agencyCreditAllocations.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (previous) {
      if (previous.amount !== input.amount || previous.workspaceId !== input.workspaceId) {
        throw new AppError("ALLOCATION_REFERENCE_CONFLICT", "Allocation reference was already used for another transfer.", 409);
      }
      return previous;
    }

    await assertActiveAgency(tx, input.purchaserUserId);
    const [client] = await tx.select({ workspaceId: workspaces.id }).from(workspaceCommercialOwners)
      .innerJoin(workspaces, eq(workspaces.id, workspaceCommercialOwners.workspaceId))
      .where(and(
        eq(workspaceCommercialOwners.workspaceId, input.workspaceId),
        eq(workspaceCommercialOwners.purchaserUserId, input.purchaserUserId),
        eq(workspaceCommercialOwners.kind, "ADDITIONAL"),
        eq(workspaces.status, "ACTIVE"),
      )).limit(1);
    if (!client) throw new AppError("AGENCY_CLIENT_NOT_FOUND", "That active client workspace is not owned by your Agency.", 404);

    const [pool] = await tx.update(agencyCreditPools).set({
      balance: sql`${agencyCreditPools.balance} - ${input.amount}`,
      updatedAt: new Date(),
    }).where(and(
      eq(agencyCreditPools.purchaserUserId, input.purchaserUserId),
      gte(agencyCreditPools.balance, input.amount),
    )).returning({ balance: agencyCreditPools.balance });
    if (!pool) throw new AppError("INSUFFICIENT_AGENCY_CREDITS", "Your Agency pool has insufficient credits.", 402);

    await lockWorkspaceWallet(tx, input.workspaceId);
    await tx.insert(creditWallets).values({ workspaceId: input.workspaceId, balance: 0 }).onConflictDoNothing();
    const [wallet] = await tx.update(creditWallets).set({
      balance: sql`${creditWallets.balance} + ${input.amount}`,
      updatedAt: new Date(),
    }).where(eq(creditWallets.workspaceId, input.workspaceId)).returning({ balance: creditWallets.balance });
    if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Client wallet could not be credited.", 409);

    const [allocation] = await tx.insert(agencyCreditAllocations).values({
      purchaserUserId: input.purchaserUserId,
      createdByUserId: input.purchaserUserId,
      workspaceId: input.workspaceId,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
    }).returning();
    await tx.insert(agencyCreditPoolLedger).values({
      purchaserUserId: input.purchaserUserId,
      type: "ALLOCATION", amount: -input.amount, balanceAfter: pool.balance,
      reason: "Credits allocated to client workspace",
      referenceType: "AGENCY_ALLOCATION", referenceId: allocation.id,
    });
    await tx.insert(creditLedger).values({
      workspaceId: input.workspaceId,
      type: "ADJUSTMENT", amount: input.amount, balanceAfter: wallet.balance,
      reason: "Credits allocated by Agency",
      referenceType: "AGENCY_ALLOCATION", referenceId: allocation.id,
    });
    return allocation;
  });
}

export async function getAgencyCreditOverview(purchaserUserId: string) {
  await requireAgencyCreditPurchaser(purchaserUserId);
  const [pool, ledger, allocations] = await Promise.all([
    db.select({ balance: agencyCreditPools.balance }).from(agencyCreditPools)
      .where(eq(agencyCreditPools.purchaserUserId, purchaserUserId)).limit(1),
    db.select().from(agencyCreditPoolLedger)
      .where(eq(agencyCreditPoolLedger.purchaserUserId, purchaserUserId))
      .orderBy(desc(agencyCreditPoolLedger.createdAt)).limit(100),
    db.select({
      id: agencyCreditAllocations.id,
      workspaceId: agencyCreditAllocations.workspaceId,
      workspaceName: workspaces.name,
      amount: agencyCreditAllocations.amount,
      createdAt: agencyCreditAllocations.createdAt,
    }).from(agencyCreditAllocations)
      .innerJoin(workspaces, eq(workspaces.id, agencyCreditAllocations.workspaceId))
      .where(eq(agencyCreditAllocations.purchaserUserId, purchaserUserId))
      .orderBy(desc(agencyCreditAllocations.createdAt)).limit(100),
  ]);
  return { balance: pool[0]?.balance ?? 0, ledger, allocations };
}

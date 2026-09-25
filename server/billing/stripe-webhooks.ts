import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db";
import {
  creditLedger,
  creditTopups,
  creditWallets,
  stripeWebhookEvents,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { creditAgencyPoolTopupInTx, adjustAgencyPoolForPaymentInTx } from "@/server/agency/credit-pool";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function objectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function lockEvent(tx: Tx, eventId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stripe-event:${eventId}`}))`);
}

async function lockTopup(tx: Tx, topupId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit-topup:${topupId}`}))`);
}

async function ensureWallet(tx: Tx, workspaceId: string) {
  await tx.insert(creditWallets).values({ workspaceId, balance: 0 }).onConflictDoNothing();
}

async function fulfillCheckout(tx: Tx, eventId: string, session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid") return;
  const topupId = session.metadata?.topupId ?? session.client_reference_id;
  if (!topupId) throw new AppError("STRIPE_TOPUP_REFERENCE_MISSING", "Stripe Checkout is missing the credit top-up reference.", 409);

  await lockTopup(tx, topupId);
  const [topup] = await tx.select().from(creditTopups).where(eq(creditTopups.id, topupId)).limit(1);
  if (!topup) throw new AppError("STRIPE_TOPUP_NOT_FOUND", "Credit top-up could not be found.", 409);
  if (session.metadata?.workspaceId && session.metadata.workspaceId !== topup.workspaceId) {
    throw new AppError("STRIPE_TOPUP_WORKSPACE_MISMATCH", "Stripe Checkout workspace metadata does not match the top-up.", 409);
  }
  if (session.metadata?.fundingDestination && session.metadata.fundingDestination !== topup.fundingDestination) {
    throw new AppError("STRIPE_TOPUP_DESTINATION_MISMATCH", "Stripe Checkout funding destination does not match the purchase.", 409);
  }
  if (session.metadata?.agencyPurchaserUserId && session.metadata.agencyPurchaserUserId !== topup.agencyPurchaserUserId) {
    throw new AppError("STRIPE_TOPUP_OWNER_MISMATCH", "Stripe Checkout purchaser does not match the purchase.", 409);
  }
  if (session.amount_total !== topup.amountCents || session.currency?.toLowerCase() !== topup.currency.toLowerCase()) {
    throw new AppError("STRIPE_TOPUP_AMOUNT_MISMATCH", "Stripe Checkout amount does not match the selected credit pack.", 409);
  }

  if (topup.fundingDestination === "AGENCY_POOL") {
    if (!topup.agencyPurchaserUserId) throw new AppError("AGENCY_POOL_PURCHASER_MISSING", "Agency pool buyer was not recorded.", 409);
    await creditAgencyPoolTopupInTx(tx, topup.agencyPurchaserUserId, topup.id, topup.credits);
  } else {
  const [existingPurchase] = await tx.select({ id: creditLedger.id }).from(creditLedger).where(and(
    eq(creditLedger.workspaceId, topup.workspaceId),
    eq(creditLedger.type, "PURCHASE"),
    eq(creditLedger.referenceType, "STRIPE_TOPUP"),
    eq(creditLedger.referenceId, topup.id),
  )).limit(1);

  await ensureWallet(tx, topup.workspaceId);
  if (!existingPurchase) {
    const [wallet] = await tx.update(creditWallets).set({
      balance: sql`${creditWallets.balance} + ${topup.credits}`,
      updatedAt: new Date(),
    }).where(eq(creditWallets.workspaceId, topup.workspaceId)).returning({ balance: creditWallets.balance });
    if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Credit wallet could not be created.", 409);

    await tx.insert(creditLedger).values({
      workspaceId: topup.workspaceId,
      type: "PURCHASE",
      amount: topup.credits,
      balanceAfter: wallet.balance,
      reason: `Stripe credit top-up ${topup.packCode}`,
      referenceType: "STRIPE_TOPUP",
      referenceId: topup.id,
    });
  }

  }

  await tx.update(creditTopups).set({
    status: "PAID",
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: objectId(session.payment_intent),
    paidAt: topup.paidAt ?? new Date(),
    metadata: { ...topup.metadata, fulfilledByEventId: eventId },
    updatedAt: new Date(),
  }).where(eq(creditTopups.id, topup.id));
}

async function findTopupForPayment(
  tx: Tx,
  input: { paymentIntentId?: string | null; chargeId?: string | null },
) {
  if (input.paymentIntentId) {
    const [topup] = await tx.select().from(creditTopups)
      .where(eq(creditTopups.stripePaymentIntentId, input.paymentIntentId))
      .limit(1);
    if (topup) return topup;
  }
  if (input.chargeId) {
    const [topup] = await tx.select().from(creditTopups)
      .where(eq(creditTopups.stripeChargeId, input.chargeId))
      .limit(1);
    if (topup) return topup;
  }
  return null;
}

function proportionalCredits(credits: number, lostCents: number, amountCents: number) {
  if (lostCents <= 0) return 0;
  if (lostCents >= amountCents) return credits;
  return Math.floor((credits * lostCents) / amountCents);
}

function topupStatus(topup: typeof creditTopups.$inferSelect, refunded: number, disputed: number) {
  if (disputed > 0) return topup.status === "CHARGEBACK" ? "CHARGEBACK" : "DISPUTED";
  if (refunded >= topup.amountCents) return "REFUNDED";
  if (refunded > 0) return "PARTIALLY_REFUNDED";
  return "PAID";
}

async function reconcileLoss(
  tx: Tx,
  eventId: string,
  topup: typeof creditTopups.$inferSelect,
  input: {
    refundedAmountCents?: number;
    disputedAmountCents?: number;
    chargeId?: string | null;
    disputeId?: string | null;
  },
) {
  await lockTopup(tx, topup.id);
  const [current] = await tx.select().from(creditTopups).where(eq(creditTopups.id, topup.id)).limit(1);
  if (!current) throw new AppError("STRIPE_TOPUP_NOT_FOUND", "Credit top-up could not be found.", 409);
  if (!current.paidAt) throw new AppError("STRIPE_TOPUP_NOT_PAID", "A refund or dispute arrived before the top-up was fulfilled.", 409);

  const refundedAmountCents = Math.max(0, Math.min(
    current.amountCents,
    input.refundedAmountCents ?? current.refundedAmountCents,
  ));
  const disputedAmountCents = Math.max(0, Math.min(
    current.amountCents,
    input.disputedAmountCents ?? current.disputedAmountCents,
  ));
  const lostCents = Math.min(current.amountCents, refundedAmountCents + disputedAmountCents);
  const targetReversedCredits = proportionalCredits(current.credits, lostCents, current.amountCents);
  const delta = targetReversedCredits - current.reversedCredits;

  if (delta !== 0) {
    if (current.fundingDestination === "AGENCY_POOL") {
      if (!current.agencyPurchaserUserId) throw new AppError("AGENCY_POOL_PURCHASER_MISSING", "Agency pool buyer was not recorded.", 409);
      await adjustAgencyPoolForPaymentInTx(tx, current.agencyPurchaserUserId, eventId, -delta);
    } else {
      await ensureWallet(tx, current.workspaceId);
      const [wallet] = await tx.update(creditWallets).set({
        balance: sql`${creditWallets.balance} - ${delta}`,
        updatedAt: new Date(),
      }).where(eq(creditWallets.workspaceId, current.workspaceId)).returning({ balance: creditWallets.balance });
      if (!wallet) throw new AppError("CREDIT_WALLET_NOT_FOUND", "Credit wallet could not be updated.", 409);

      await tx.insert(creditLedger).values({
        workspaceId: current.workspaceId,
        type: "ADJUSTMENT",
        amount: -delta,
        balanceAfter: wallet.balance,
        reason: delta > 0 ? "Stripe top-up refund or dispute reversal" : "Stripe dispute reversal restored credits",
        referenceType: "STRIPE_EVENT",
        referenceId: eventId,
      });
    }
  }

  await tx.update(creditTopups).set({
    refundedAmountCents,
    disputedAmountCents,
    reversedCredits: targetReversedCredits,
    status: topupStatus(current, refundedAmountCents, disputedAmountCents),
    stripeChargeId: input.chargeId ?? current.stripeChargeId,
    stripeDisputeId: input.disputeId ?? current.stripeDisputeId,
    updatedAt: new Date(),
  }).where(eq(creditTopups.id, current.id));
}

async function handleChargeRefunded(tx: Tx, eventId: string, charge: Stripe.Charge) {
  const paymentIntentId = objectId(charge.payment_intent);
  const topup = await findTopupForPayment(tx, { paymentIntentId, chargeId: charge.id });
  if (!topup) throw new AppError("STRIPE_TOPUP_NOT_FOUND", "Refunded Stripe charge is not linked to a credit top-up.", 409);
  await reconcileLoss(tx, eventId, topup, {
    refundedAmountCents: charge.amount_refunded,
    chargeId: charge.id,
  });
}

async function handleDispute(tx: Tx, eventId: string, dispute: Stripe.Dispute, closed: boolean) {
  const paymentIntentId = objectId(dispute.payment_intent);
  const chargeId = objectId(dispute.charge);
  const topup = await findTopupForPayment(tx, { paymentIntentId, chargeId });
  if (!topup) throw new AppError("STRIPE_TOPUP_NOT_FOUND", "Stripe dispute is not linked to a credit top-up.", 409);

  const disputedAmountCents = closed && dispute.status === "won" ? 0 : dispute.amount;
  await reconcileLoss(tx, eventId, topup, {
    disputedAmountCents,
    chargeId,
    disputeId: dispute.id,
  });

  if (closed && dispute.status === "lost") {
    await tx.update(creditTopups).set({ status: "CHARGEBACK", updatedAt: new Date() })
      .where(eq(creditTopups.id, topup.id));
  }
}

async function markCheckoutTerminal(
  tx: Tx,
  session: Stripe.Checkout.Session,
  status: "PAYMENT_FAILED" | "EXPIRED",
) {
  const topupId = session.metadata?.topupId ?? session.client_reference_id;
  if (!topupId) return;
  await lockTopup(tx, topupId);
  const [topup] = await tx.select().from(creditTopups).where(eq(creditTopups.id, topupId)).limit(1);
  if (!topup || topup.paidAt) return;
  await tx.update(creditTopups).set({
    status,
    stripeCheckoutSessionId: session.id,
    updatedAt: new Date(),
  }).where(eq(creditTopups.id, topupId));
}

export async function processStripeWebhookEvent(event: Stripe.Event) {
  try {
    return await db.transaction(async (tx) => {
    await lockEvent(tx, event.id);
    const [existing] = await tx.select().from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.stripeEventId, event.id)).limit(1);
    if (existing?.status === "PROCESSED") return { duplicate: true as const };

    if (existing) {
      await tx.update(stripeWebhookEvents).set({
        eventType: event.type,
        status: "RECEIVED",
        error: null,
        processedAt: null,
      }).where(eq(stripeWebhookEvents.stripeEventId, event.id));
    } else {
      await tx.insert(stripeWebhookEvents).values({
        stripeEventId: event.id,
        eventType: event.type,
        status: "RECEIVED",
      });
    }

    switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          await fulfillCheckout(tx, event.id, event.data.object as Stripe.Checkout.Session);
          break;
        case "checkout.session.async_payment_failed":
          await markCheckoutTerminal(tx, event.data.object as Stripe.Checkout.Session, "PAYMENT_FAILED");
          break;
        case "checkout.session.expired":
          await markCheckoutTerminal(tx, event.data.object as Stripe.Checkout.Session, "EXPIRED");
          break;
        case "charge.refunded":
          await handleChargeRefunded(tx, event.id, event.data.object as Stripe.Charge);
          break;
        case "charge.dispute.created":
          await handleDispute(tx, event.id, event.data.object as Stripe.Dispute, false);
          break;
        case "charge.dispute.closed":
          await handleDispute(tx, event.id, event.data.object as Stripe.Dispute, true);
          break;
        default:
          break;
      }

    await tx.update(stripeWebhookEvents).set({
      status: "PROCESSED",
      processedAt: new Date(),
    }).where(eq(stripeWebhookEvents.stripeEventId, event.id));
    return { duplicate: false as const };
    });
  } catch (error) {
    await db.insert(stripeWebhookEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      status: "FAILED",
      error: error instanceof Error ? error.message.slice(0, 1000) : "Unknown Stripe webhook error",
      processedAt: new Date(),
    }).onConflictDoUpdate({
      target: stripeWebhookEvents.stripeEventId,
      set: {
        eventType: event.type,
        status: "FAILED",
        error: error instanceof Error ? error.message.slice(0, 1000) : "Unknown Stripe webhook error",
        processedAt: new Date(),
      },
    }).catch(() => undefined);
    throw error;
  }
}

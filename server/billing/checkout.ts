import { randomBytes } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { creditLedger, creditPacks, creditTopups, usageEvents } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { getStripeClient } from "./stripe-client";
import { requireWorkspaceCreditPurchaser } from "./workspace-topup-access";

function integrationIdentifier() {
  const bytes = randomBytes(8);
  let suffix = "";
  for (const byte of bytes) suffix += String.fromCharCode(97 + (byte % 26));
  return `ai_caller_topup_${suffix}`;
}

export async function listActiveCreditPacks() {
  return db.select({
    code: creditPacks.code,
    name: creditPacks.name,
    credits: creditPacks.credits,
    amountCents: creditPacks.amountCents,
    currency: creditPacks.currency,
  })
    .from(creditPacks)
    .where(eq(creditPacks.active, true))
    .orderBy(asc(creditPacks.sortOrder), asc(creditPacks.amountCents));
}

export async function createCreditTopupCheckout(input: {
  workspaceId: string;
  userId: string;
  customerEmail: string;
  packCode: string;
  appBaseUrl: string;
  fundingDestination?: "WORKSPACE" | "AGENCY_POOL";
  agencyPurchaserUserId?: string;
}) {
  await requireWorkspaceCreditPurchaser(input.userId, input.workspaceId);
  if (input.fundingDestination === "AGENCY_POOL" && input.agencyPurchaserUserId !== input.userId) {
    throw new AppError("AGENCY_POOL_PURCHASER_MISMATCH", "Only the Agency purchaser may fund this pool.", 403);
  }
  const [pack] = await db.select().from(creditPacks).where(and(
    eq(creditPacks.code, input.packCode),
    eq(creditPacks.active, true),
  )).limit(1);
  if (!pack) throw new AppError("CREDIT_PACK_NOT_FOUND", "That credit pack is not available.", 404);

  const [topup] = await db.insert(creditTopups).values({
    workspaceId: input.workspaceId,
    fundingDestination: input.fundingDestination ?? "WORKSPACE",
    agencyPurchaserUserId: input.fundingDestination === "AGENCY_POOL" ? input.agencyPurchaserUserId : null,
    createdByUserId: input.userId,
    packCode: pack.code,
    credits: pack.credits,
    amountCents: pack.amountCents,
    currency: pack.currency.toLowerCase(),
    status: "PENDING",
  }).returning();

  const stripe = getStripeClient();
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      integration_identifier: integrationIdentifier(),
      client_reference_id: topup.id,
      customer_email: input.customerEmail,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: topup.currency,
          unit_amount: topup.amountCents,
          product_data: {
            name: pack.name,
            description: `${pack.credits.toLocaleString("en-US")} AI Caller hosted usage credits`,
          },
        },
      }],
      metadata: {
        workspaceId: input.workspaceId,
        fundingDestination: topup.fundingDestination,
        agencyPurchaserUserId: topup.agencyPurchaserUserId ?? "",
        topupId: topup.id,
        packCode: topup.packCode,
      },
      payment_intent_data: {
        metadata: {
          workspaceId: input.workspaceId,
          fundingDestination: topup.fundingDestination,
          agencyPurchaserUserId: topup.agencyPurchaserUserId ?? "",
          topupId: topup.id,
          packCode: topup.packCode,
        },
      },
      success_url: `${input.appBaseUrl.replace(/\/$/, "")}${topup.fundingDestination === "AGENCY_POOL" ? "/workspaces" : "/settings/billing"}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${input.appBaseUrl.replace(/\/$/, "")}${topup.fundingDestination === "AGENCY_POOL" ? "/workspaces" : "/settings/billing"}?checkout=cancelled`,
    }, {
      idempotencyKey: `credit-topup:${topup.id}`,
    });

    if (!session.url) throw new Error("Stripe Checkout did not return a hosted checkout URL.");
    await db.update(creditTopups).set({
      stripeCheckoutSessionId: session.id,
      status: "CHECKOUT_CREATED",
      updatedAt: new Date(),
    }).where(eq(creditTopups.id, topup.id));

    return {
      topupId: topup.id,
      checkoutSessionId: session.id,
      url: session.url,
    };
  } catch (error) {
    await db.update(creditTopups).set({
      status: "CHECKOUT_FAILED",
      metadata: {
        ...topup.metadata,
        checkoutError: error instanceof Error ? error.message.slice(0, 500) : "Unknown Stripe checkout error",
      },
      updatedAt: new Date(),
    }).where(eq(creditTopups.id, topup.id)).catch(() => undefined);
    throw error;
  }
}

export async function getBillingOverview(workspaceId: string) {
  const [packs, ledger, topups, usage] = await Promise.all([
    listActiveCreditPacks(),
    db.select({
      id: creditLedger.id,
      type: creditLedger.type,
      amount: creditLedger.amount,
      balanceAfter: creditLedger.balanceAfter,
      reason: creditLedger.reason,
      createdAt: creditLedger.createdAt,
    }).from(creditLedger)
      .where(eq(creditLedger.workspaceId, workspaceId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(100),
    db.select({
      id: creditTopups.id,
      packCode: creditTopups.packCode,
      credits: creditTopups.credits,
      amountCents: creditTopups.amountCents,
      currency: creditTopups.currency,
      status: creditTopups.status,
      refundedAmountCents: creditTopups.refundedAmountCents,
      disputedAmountCents: creditTopups.disputedAmountCents,
      reversedCredits: creditTopups.reversedCredits,
      paidAt: creditTopups.paidAt,
      createdAt: creditTopups.createdAt,
    }).from(creditTopups)
      .where(and(eq(creditTopups.workspaceId, workspaceId), eq(creditTopups.fundingDestination, "WORKSPACE")))
      .orderBy(desc(creditTopups.createdAt))
      .limit(50),
    db.select({
      id: usageEvents.id,
      capability: usageEvents.capability,
      provider: usageEvents.provider,
      mode: usageEvents.mode,
      creditsCharged: usageEvents.creditsCharged,
      createdAt: usageEvents.createdAt,
    }).from(usageEvents)
      .where(eq(usageEvents.workspaceId, workspaceId))
      .orderBy(desc(usageEvents.createdAt))
      .limit(200),
  ]);
  return { packs, ledger, topups, usage };
}

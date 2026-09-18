import type Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  creditLedger,
  creditPacks,
  creditTopups,
  creditWallets,
  stripeWebhookEvents,
  user,
  workspaces,
} from "@/db/schema";
import { processStripeWebhookEvent } from "./stripe-webhooks";

const userId = "stripe-topup-user";
let workspaceId = "";

function event(id: string, type: Stripe.Event["type"], object: unknown): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  } as unknown as Stripe.Event;
}

async function createTopup() {
  const [topup] = await db.insert(creditTopups).values({
    workspaceId,
    createdByUserId: userId,
    packCode: "CREDITS_10000",
    credits: 10_000,
    amountCents: 1_000,
    currency: "usd",
    status: "CHECKOUT_CREATED",
    stripeCheckoutSessionId: "cs_test_topup",
  }).returning();
  return topup;
}

function paidSession(topupId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_topup",
    object: "checkout.session",
    client_reference_id: topupId,
    amount_total: 1000,
    currency: "usd",
    payment_status: "paid",
    payment_intent: "pi_test_topup",
    metadata: { workspaceId, topupId, packCode: "CREDITS_10000" },
    ...overrides,
  };
}

describe("Stripe credit top-up webhooks", () => {
  beforeEach(async () => {
    await db.delete(stripeWebhookEvents);
    await db.delete(creditTopups);
    await db.delete(creditLedger);
    await db.delete(creditWallets);
    await db.delete(workspaces);
    await db.delete(user);

    await db.insert(creditPacks).values({
      code: "CREDITS_10000",
      name: "10,000 credits",
      credits: 10_000,
      amountCents: 1_000,
      currency: "usd",
      sortOrder: 10,
    }).onConflictDoUpdate({
      target: creditPacks.code,
      set: { credits: 10_000, amountCents: 1_000, active: true, updatedAt: new Date() },
    });
    await db.insert(user).values({
      id: userId,
      name: "Stripe Tester",
      email: "stripe-tester@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Stripe Top-up Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(creditWallets).values({ workspaceId, balance: 5 });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("grants a paid Checkout top-up exactly once across webhook retries", async () => {
    const topup = await createTopup();
    const completed = event("evt_checkout_paid", "checkout.session.completed", paidSession(topup.id));

    await expect(processStripeWebhookEvent(completed)).resolves.toEqual({ duplicate: false });
    await expect(processStripeWebhookEvent(completed)).resolves.toEqual({ duplicate: true });
    await processStripeWebhookEvent(event(
      "evt_checkout_paid_again",
      "checkout.session.async_payment_succeeded",
      paidSession(topup.id),
    ));

    const [wallet] = await db.select().from(creditWallets);
    expect(wallet.balance).toBe(10_005);
    const purchases = (await db.select().from(creditLedger)).filter((entry) => entry.type === "PURCHASE");
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ amount: 10_000, balanceAfter: 10_005 });

    const [stored] = await db.select().from(creditTopups);
    expect(stored).toMatchObject({
      status: "PAID",
      stripePaymentIntentId: "pi_test_topup",
    });
  });

  it("reverses refunds and restores a won dispute without allowing double adjustments", async () => {
    const topup = await createTopup();
    await processStripeWebhookEvent(event("evt_paid", "checkout.session.completed", paidSession(topup.id)));

    await processStripeWebhookEvent(event("evt_refund_half", "charge.refunded", {
      id: "ch_test_topup",
      object: "charge",
      payment_intent: "pi_test_topup",
      amount: 1000,
      amount_refunded: 500,
    }));
    expect((await db.select().from(creditWallets))[0].balance).toBe(5_005);

    await processStripeWebhookEvent(event("evt_dispute", "charge.dispute.created", {
      id: "dp_test_topup",
      object: "dispute",
      payment_intent: "pi_test_topup",
      charge: "ch_test_topup",
      amount: 1000,
      status: "needs_response",
    }));
    expect((await db.select().from(creditWallets))[0].balance).toBe(5);

    const won = event("evt_dispute_won", "charge.dispute.closed", {
      id: "dp_test_topup",
      object: "dispute",
      payment_intent: "pi_test_topup",
      charge: "ch_test_topup",
      amount: 1000,
      status: "won",
    });
    await processStripeWebhookEvent(won);
    await processStripeWebhookEvent(won);

    expect((await db.select().from(creditWallets))[0].balance).toBe(5_005);
    const [stored] = await db.select().from(creditTopups);
    expect(stored).toMatchObject({
      status: "PARTIALLY_REFUNDED",
      refundedAmountCents: 500,
      disputedAmountCents: 0,
      reversedCredits: 5000,
    });
    const adjustments = (await db.select().from(creditLedger)).filter((entry) => entry.type === "ADJUSTMENT");
    expect(adjustments).toHaveLength(3);
    expect(adjustments.map((entry) => entry.amount)).toEqual([-5000, -5000, 5000]);
  });

  it("fails closed on amount tampering and preserves a retryable failed event record", async () => {
    const topup = await createTopup();
    const mismatched = event(
      "evt_bad_amount",
      "checkout.session.completed",
      paidSession(topup.id, { amount_total: 999 }),
    );

    await expect(processStripeWebhookEvent(mismatched)).rejects.toMatchObject({
      code: "STRIPE_TOPUP_AMOUNT_MISMATCH",
    });
    expect((await db.select().from(creditWallets))[0].balance).toBe(5);
    expect(await db.select().from(creditLedger)).toHaveLength(0);
    expect((await db.select().from(stripeWebhookEvents))[0]).toMatchObject({
      stripeEventId: "evt_bad_amount",
      status: "FAILED",
    });
  });
});

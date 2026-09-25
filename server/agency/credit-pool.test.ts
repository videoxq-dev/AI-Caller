import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  agencyCreditAllocations, agencyCreditPoolLedger, agencyCreditPools,
  creditLedger, creditTopups, creditWallets, licenses,
  user, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { getCreditBalance } from "@/server/credits/service";
import { processStripeWebhookEvent } from "@/server/billing/stripe-webhooks";
import { getBillingOverview } from "@/server/billing/checkout";
import { allocateAgencyCredits, getAgencyCreditOverview } from "./credit-pool";

let ownerId = "";
let clientOwnerId = "";
let otherOwnerId = "";
let originalId = "";
let clientId = "";
let otherClientId = "";
const createdEvents: string[] = [];

function stripeEvent(id: string, type: Stripe.Event["type"], object: unknown): Stripe.Event {
  createdEvents.push(id);
  return {
    id, object: "event", api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000), data: { object },
    livemode: false, pending_webhooks: 1,
    request: { id: null, idempotency_key: null }, type,
  } as unknown as Stripe.Event;
}

async function purchaseAgencyCredits(amount = 10_000) {
  const [topup] = await db.insert(creditTopups).values({
    workspaceId: originalId,
    fundingDestination: "AGENCY_POOL",
    agencyPurchaserUserId: ownerId,
    createdByUserId: ownerId,
    packCode: "CREDITS_10000",
    credits: amount,
    amountCents: 1000,
    currency: "usd",
    status: "CHECKOUT_CREATED",
    stripeCheckoutSessionId: `cs_${randomUUID()}`,
  }).returning();
  const session = {
    id: topup.stripeCheckoutSessionId,
    object: "checkout.session",
    client_reference_id: topup.id,
    payment_status: "paid",
    payment_intent: `pi_${randomUUID()}`,
    amount_total: topup.amountCents,
    currency: "usd",
    metadata: {
      workspaceId: originalId,
      agencyPurchaserUserId: ownerId,
      fundingDestination: "AGENCY_POOL",
      topupId: topup.id,
    },
  };
  await processStripeWebhookEvent(stripeEvent(`evt_${randomUUID()}`, "checkout.session.completed", session));
  return { topup, session };
}

describe("purchaser-owned Agency credit pool", () => {
  beforeEach(async () => {
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    clientOwnerId = randomUUID();
    await db.insert(user).values([
      { id: ownerId, name: "Agency Buyer", email: `${ownerId}@example.com`, emailVerified: true },
      { id: otherOwnerId, name: "Other Agency Buyer", email: `${otherOwnerId}@example.com`, emailVerified: true },
      { id: clientOwnerId, name: "Delegated Client", email: `${clientOwnerId}@example.com`, emailVerified: true },
    ]);
    const rows = await db.insert(workspaces).values([
      { name: "Agency Original" }, { name: "Agency Client" }, { name: "Other Agency Client" },
    ]).returning({ id: workspaces.id });
    [originalId, clientId, otherClientId] = rows.map((row) => row.id);
    await db.insert(workspaceCommercialOwners).values([
      { workspaceId: originalId, purchaserUserId: ownerId, kind: "PRIMARY" },
      { workspaceId: clientId, purchaserUserId: ownerId, kind: "ADDITIONAL" },
      { workspaceId: otherClientId, purchaserUserId: otherOwnerId, kind: "ADDITIONAL" },
    ]);
    await db.insert(licenses).values({
      workspaceId: originalId, purchaserUserId: ownerId, source: "MANUAL",
      externalPurchaseId: randomUUID(), productCode: "AGENCY_50",
      status: "ACTIVE", purchasedAt: new Date(),
    });
  });

  afterEach(async () => {
    const { stripeWebhookEvents } = await import("@/db/schema");
    for (const id of createdEvents.splice(0)) {
      await db.delete(stripeWebhookEvents).where(eq(stripeWebhookEvents.stripeEventId, id));
    }
    for (const id of [clientId, otherClientId, originalId]) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    for (const id of [clientOwnerId, otherOwnerId, ownerId]) {
      await db.delete(user).where(eq(user.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(creditPacks).where(eq(creditPacks.code, "AGENCY_POOL_TEST"));
    await closeDatabase();
  });

  it("starts client wallets at zero and grants a verified purchase only to the Agency pool", async () => {
    expect(await getCreditBalance(clientId)).toBe(0);
    expect(await getCreditBalance(originalId)).toBe(0);

    const { topup, session } = await purchaseAgencyCredits();
    expect((await getAgencyCreditOverview(ownerId)).balance).toBe(10_000);
    expect(await getCreditBalance(clientId)).toBe(0);
    expect(await getCreditBalance(originalId)).toBe(0);
    expect((await getBillingOverview(originalId)).topups).toHaveLength(0);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, originalId))).toHaveLength(0);

    await processStripeWebhookEvent(stripeEvent(`evt_${randomUUID()}`, "checkout.session.async_payment_succeeded", session));
    expect((await getAgencyCreditOverview(ownerId)).balance).toBe(10_000);
    const purchases = await db.select().from(agencyCreditPoolLedger).where(and(
      eq(agencyCreditPoolLedger.referenceId, topup.id),
      eq(agencyCreditPoolLedger.type, "PURCHASE"),
    ));
    expect(purchases).toHaveLength(1);
  });

  it("transfers the same amount out of the Agency pool and into only the target client", async () => {
    await purchaseAgencyCredits();
    const key = randomUUID();
    const input = { purchaserUserId: ownerId, workspaceId: clientId, amount: 3_000, idempotencyKey: key };
    const allocated = await allocateAgencyCredits(input);
    expect(await allocateAgencyCredits(input)).toMatchObject({ id: allocated.id });
    expect((await getAgencyCreditOverview(ownerId)).balance).toBe(7_000);
    expect(await getCreditBalance(clientId)).toBe(3_000);
    expect(await getCreditBalance(originalId)).toBe(0);
    expect(await getCreditBalance(otherClientId)).toBe(0);
    expect(await db.select().from(agencyCreditAllocations).where(eq(agencyCreditAllocations.idempotencyKey, key)))
      .toHaveLength(1);
    expect(await db.select().from(agencyCreditPoolLedger).where(eq(agencyCreditPoolLedger.referenceId, allocated.id)))
      .toMatchObject([{ amount: -3_000, balanceAfter: 7_000 }]);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.referenceId, allocated.id)))
      .toMatchObject([{ workspaceId: clientId, amount: 3_000, balanceAfter: 3_000 }]);
    await expect(allocateAgencyCredits({ ...input, amount: 4_000 }))
      .rejects.toMatchObject({ code: "ALLOCATION_REFERENCE_CONFLICT" });
  });

  it("blocks concurrent overspending and cross-Agency allocation", async () => {
    await purchaseAgencyCredits();
    const results = await Promise.allSettled([
      allocateAgencyCredits({ purchaserUserId: ownerId, workspaceId: clientId, amount: 6_000, idempotencyKey: randomUUID() }),
      allocateAgencyCredits({ purchaserUserId: ownerId, workspaceId: clientId, amount: 6_000, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await getAgencyCreditOverview(ownerId)).balance).toBe(4_000);
    expect(await getCreditBalance(clientId)).toBe(6_000);

    await expect(allocateAgencyCredits({
      purchaserUserId: ownerId, workspaceId: otherClientId, amount: 1_000, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "AGENCY_CLIENT_NOT_FOUND", status: 404 });
    await expect(allocateAgencyCredits({
      purchaserUserId: clientOwnerId, workspaceId: clientId, amount: 100, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "AGENCY_REQUIRED", status: 403 });
    expect(await getCreditBalance(otherClientId)).toBe(0);
  });

  it("blocks new allocations after Agency revocation while preserving client balances", async () => {
    await purchaseAgencyCredits();
    await allocateAgencyCredits({
      purchaserUserId: ownerId, workspaceId: clientId, amount: 2_000, idempotencyKey: randomUUID(),
    });
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.purchaserUserId, ownerId));
    await expect(allocateAgencyCredits({
      purchaserUserId: ownerId, workspaceId: clientId, amount: 1_000, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "AGENCY_REQUIRED" });
    expect(await getCreditBalance(clientId)).toBe(2_000);
    const [pool] = await db.select().from(agencyCreditPools).where(eq(agencyCreditPools.purchaserUserId, ownerId));
    expect(pool.balance).toBe(8_000);
  });

  it("keeps distributed client credits intact if the payment provider reverses a purchase", async () => {
    const { session } = await purchaseAgencyCredits();
    await allocateAgencyCredits({
      purchaserUserId: ownerId, workspaceId: clientId, amount: 8_000, idempotencyKey: randomUUID(),
    });
    await processStripeWebhookEvent(stripeEvent(`evt_${randomUUID()}`, "charge.refunded", {
      id: `ch_${randomUUID()}`, object: "charge",
      payment_intent: session.payment_intent,
      amount: 1000, amount_refunded: 1000,
    }));
    expect(await getCreditBalance(clientId)).toBe(8_000);
    const [pool] = await db.select().from(agencyCreditPools).where(eq(agencyCreditPools.purchaserUserId, ownerId));
    expect(pool.balance).toBe(-8_000);
    await expect(allocateAgencyCredits({
      purchaserUserId: ownerId, workspaceId: clientId, amount: 1, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "INSUFFICIENT_AGENCY_CREDITS" });
  });
});

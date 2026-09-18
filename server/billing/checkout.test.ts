import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  creditLedger,
  creditTopups,
  creditWallets,
  usageEvents,
  user,
  workspaces,
} from "@/db/schema";
import { getBillingOverview } from "./checkout";

const userId = "billing-projection-user";
let workspaceId = "";

describe("customer billing projection", () => {
  beforeEach(async () => {
    await db.delete(creditTopups);
    await db.delete(usageEvents);
    await db.delete(creditLedger);
    await db.delete(creditWallets);
    await db.delete(workspaces);
    await db.delete(user);

    await db.insert(user).values({
      id: userId,
      name: "Billing Projection User",
      email: "billing-projection@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Billing Projection" }).returning();
    workspaceId = workspace.id;
    await db.insert(creditWallets).values({ workspaceId, balance: 250 });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("does not expose internal provider COGS, margin snapshots, or Stripe identifiers", async () => {
    await db.insert(usageEvents).values({
      workspaceId,
      capability: "AI_TEXT",
      provider: "openai",
      mode: "HOSTED",
      providerUsage: { inputTokens: 100, outputTokens: 20 },
      creditsCharged: 3,
      providerCostMicros: 1234,
      billedUnits: { AI_INPUT_TOKEN: 100, AI_OUTPUT_TOKEN: 20 },
      pricingDetails: {
        secretInternalMarker: "must-not-leak",
        rates: [{ targetMarginBps: 5500, costMicros: 1234 }],
      },
      referenceType: "CONVERSATION",
      referenceId: "conversation-secret-test",
    });

    await db.insert(creditTopups).values({
      workspaceId,
      createdByUserId: userId,
      packCode: "CREDITS_10000",
      credits: 10_000,
      amountCents: 1_000,
      currency: "usd",
      status: "PAID",
      stripeCheckoutSessionId: "cs_secret",
      stripePaymentIntentId: "pi_secret",
      stripeChargeId: "ch_secret",
      stripeDisputeId: "dp_secret",
      metadata: { internalMarker: "must-not-leak" },
      paidAt: new Date(),
    });

    const overview = await getBillingOverview(workspaceId);
    const usage = overview.usage[0] as Record<string, unknown>;
    const topup = overview.topups[0] as Record<string, unknown>;

    expect(usage).toMatchObject({
      provider: "openai",
      creditsCharged: 3,
      billedUnits: { AI_INPUT_TOKEN: 100, AI_OUTPUT_TOKEN: 20 },
    });
    expect(usage).not.toHaveProperty("providerCostMicros");
    expect(usage).not.toHaveProperty("pricingDetails");
    expect(JSON.stringify(usage)).not.toContain("must-not-leak");

    expect(topup).toMatchObject({
      packCode: "CREDITS_10000",
      credits: 10_000,
      amountCents: 1_000,
      status: "PAID",
    });
    for (const field of [
      "stripeCheckoutSessionId",
      "stripePaymentIntentId",
      "stripeChargeId",
      "stripeDisputeId",
      "metadata",
    ]) {
      expect(topup).not.toHaveProperty(field);
    }
    expect(JSON.stringify(topup)).not.toContain("must-not-leak");
  });
});

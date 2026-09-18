import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { creditWallets, hostedPhoneNumbers, usageEvents, workspaces } from "@/db/schema";
import { processDuePhoneNumberRenewals } from "./service";

describe("managed phone number renewals", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Phone Renewal Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("charges credits, advances the billing period and records carrier COGS once", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 5000 });
    const dueAt = new Date("2026-08-31T12:00:00.000Z");
    await db.insert(hostedPhoneNumbers).values({
      workspaceId,
      provider: "telnyx",
      providerNumberId: "number-1",
      phoneNumber: "+12025550200",
      countryCode: "US",
      numberType: "local",
      status: "ACTIVE",
      providerMonthlyCostMicros: 1_100_000,
      providerUpfrontCostMicros: 0,
      monthlyCredits: 2200,
      purchaseCredits: 2200,
      currentPeriodStart: new Date("2026-07-31T12:00:00.000Z"),
      currentPeriodEnd: dueAt,
      nextBillingAt: dueAt,
    });

    await expect(processDuePhoneNumberRenewals()).resolves.toMatchObject({ checked: 1, renewed: 1 });

    const [wallet] = await db.select().from(creditWallets);
    expect(wallet.balance).toBe(2800);

    const [number] = await db.select().from(hostedPhoneNumbers);
    expect(number.status).toBe("ACTIVE");
    expect(number.nextBillingAt?.toISOString()).toBe("2026-09-30T12:00:00.000Z");

    const events = await db.select().from(usageEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      capability: "VOICE",
      provider: "telnyx",
      mode: "HOSTED",
      creditsCharged: 2200,
      providerCostMicros: 1_100_000,
      referenceType: "PHONE_NUMBER_RENEWAL",
    });

    await expect(processDuePhoneNumberRenewals()).resolves.toMatchObject({ checked: 0, renewed: 0 });
    expect(await db.select().from(usageEvents)).toHaveLength(1);
  });

  it("starts a grace period without charging when renewal credits are insufficient", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 100 });
    await db.insert(hostedPhoneNumbers).values({
      workspaceId,
      provider: "telnyx",
      providerNumberId: "number-2",
      phoneNumber: "+12025550201",
      countryCode: "US",
      numberType: "local",
      status: "ACTIVE",
      providerMonthlyCostMicros: 1_100_000,
      providerUpfrontCostMicros: 0,
      monthlyCredits: 2200,
      purchaseCredits: 2200,
      currentPeriodStart: new Date("2026-07-31T12:00:00.000Z"),
      currentPeriodEnd: new Date("2026-08-31T12:00:00.000Z"),
      nextBillingAt: new Date("2026-08-31T12:00:00.000Z"),
    });

    await expect(processDuePhoneNumberRenewals()).resolves.toMatchObject({ checked: 1, pastDue: 1 });
    const [number] = await db.select().from(hostedPhoneNumbers);
    expect(number.status).toBe("PAST_DUE");
    expect(number.graceEndsAt).toBeInstanceOf(Date);
    expect((await db.select().from(creditWallets))[0].balance).toBe(100);
    expect(await db.select().from(usageEvents)).toHaveLength(0);
  });
});

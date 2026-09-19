import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "@/server/providers/http";
import type { TelnyxNumberOrder } from "@/server/providers/telnyx-platform";

const platform = vi.hoisted(() => ({
  createTelnyxCallControlApplication: vi.fn(async () => "call-control-1"),
  createTelnyxMessagingProfile: vi.fn(async () => "messaging-profile-1"),
  updateTelnyxCallControlApplication: vi.fn(async () => "call-control-1"),
  deleteTelnyxCallControlApplication: vi.fn(async () => undefined),
  deleteTelnyxMessagingProfile: vi.fn(async () => undefined),
  findOwnedTelnyxNumber: vi.fn<() => Promise<{ id: string; phone_number: string; status: string } | null>>(async () => ({ id: "owned-number-1", phone_number: "+12025550200", status: "active" })),
  findTelnyxNumberOrderByReference: vi.fn<() => Promise<TelnyxNumberOrder | null>>(async () => null),
  orderTelnyxNumber: vi.fn(),
  releaseTelnyxNumber: vi.fn(async () => undefined),
  retrieveTelnyxNumberOrder: vi.fn(),
  retrieveTelnyxOrderPhoneNumber: vi.fn(),
  searchTelnyxNumbers: vi.fn(async () => [{
    phoneNumber: "+12025550200",
    countryCode: "US",
    administrativeArea: "DC",
    locality: "Washington",
    numberType: "local",
    monthlyCost: "1.00",
    upfrontCost: "0.00",
    currency: "USD",
    bestEffort: false,
  }]),
}));

vi.mock("@/server/providers/telnyx-platform", () => platform);

import { closeDatabase, db } from "@/db";
import { capabilityBindings, creditWallets, hostedPhoneNumbers, integrations, usageEvents, workspaces } from "@/db/schema";
import { processPendingPhoneNumberProvisioning, provisionManagedPhoneNumber, refreshManagedVoiceWebhook, releaseManagedPhoneNumber } from "./service";

const requestId = "11111111-1111-4111-8111-111111111111";

describe("managed phone provisioning lifecycle", () => {
  let workspaceId = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    platform.createTelnyxCallControlApplication.mockResolvedValue("call-control-1");
    platform.createTelnyxMessagingProfile.mockResolvedValue("messaging-profile-1");
    platform.updateTelnyxCallControlApplication.mockResolvedValue("call-control-1");
    platform.deleteTelnyxCallControlApplication.mockResolvedValue(undefined);
    platform.deleteTelnyxMessagingProfile.mockResolvedValue(undefined);
    platform.releaseTelnyxNumber.mockResolvedValue(undefined);
    platform.findOwnedTelnyxNumber.mockResolvedValue({ id: "owned-number-1", phone_number: "+12025550200", status: "active" });
    platform.findTelnyxNumberOrderByReference.mockResolvedValue(null);
    platform.searchTelnyxNumbers.mockResolvedValue([{
      phoneNumber: "+12025550200",
      countryCode: "US",
      administrativeArea: "DC",
      locality: "Washington",
      numberType: "local",
      monthlyCost: "1.00",
      upfrontCost: "0.00",
      currency: "USD",
      bestEffort: false,
    }]);
    platform.orderTelnyxNumber.mockResolvedValue({
      id: "order-1",
      status: "pending",
      requirements_met: true,
      phone_numbers: [{
        id: "order-number-1",
        phone_number: "+12025550200",
        status: "pending",
        requirements_met: true,
      }],
    });
    platform.retrieveTelnyxNumberOrder.mockResolvedValue({
      id: "order-1",
      status: "pending",
      requirements_met: true,
    });
    platform.retrieveTelnyxOrderPhoneNumber.mockResolvedValue({
      id: "order-number-1",
      phone_number: "+12025550200",
      status: "success",
      requirements_met: true,
    });

    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Managed Provisioning Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(creditWallets).values({ workspaceId, balance: 10_000 });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("waits for individual-number success and active account inventory before activating", async () => {
    const number = await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    });

    expect(platform.orderTelnyxNumber).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      requestId,
      phoneNumber: "+12025550200",
    }));
    expect(platform.retrieveTelnyxNumberOrder).toHaveBeenCalledWith("order-1");
    expect(platform.retrieveTelnyxOrderPhoneNumber).toHaveBeenCalledWith("order-number-1");
    expect(number).toMatchObject({
      phoneNumber: "+12025550200",
      status: "ACTIVE",
      messagingReadiness: "NOT_REGISTERED",
    });

    const [stored] = await db.select().from(hostedPhoneNumbers);
    expect(stored).toMatchObject({
      providerOrderId: "order-1",
      providerOrderPhoneNumberId: "order-number-1",
      providerNumberId: "owned-number-1",
      providerOrderStatus: "pending",
      status: "ACTIVE",
      messagingReadiness: "NOT_REGISTERED",
    });
    expect((await db.select().from(capabilityBindings)).map((row) => row.capability).sort()).toEqual(["SMS", "VOICE"]);
    expect((await db.select().from(usageEvents))).toHaveLength(1);
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);
  });

  it("repairs an owned active voice app without buying or replacing a number", async () => {
    const [row] = await db.insert(hostedPhoneNumbers).values({
      workspaceId, provider: "telnyx", phoneNumber: "+12025550200",
      countryCode: "US", numberType: "local", status: "ACTIVE",
      messagingReadiness: "NOT_REGISTERED", voiceConnectionId: "call-control-1",
      providerMonthlyCostMicros: 1_000_000, providerUpfrontCostMicros: 0,
      purchaseCredits: 2000, monthlyCredits: 2000,
    }).returning();
    await expect(refreshManagedVoiceWebhook(workspaceId)).resolves.toEqual({
      phoneNumberId: row.id, status: "UPDATED", webhookOrigin: "http://localhost:3000",
    });
    expect(platform.updateTelnyxCallControlApplication).toHaveBeenCalledWith(
      workspaceId, "call-control-1",
      `http://localhost:3000/api/webhooks/voice/telnyx/${workspaceId}`,
    );
    expect(platform.createTelnyxCallControlApplication).not.toHaveBeenCalled();
    expect(platform.orderTelnyxNumber).not.toHaveBeenCalled();
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
  });

  it("refuses voice callback repair without an existing active owned app", async () => {
    await expect(refreshManagedVoiceWebhook(workspaceId)).rejects.toMatchObject({
      code: "VOICE_CONNECTION_NOT_READY", status: 409,
    });
    expect(platform.updateTelnyxCallControlApplication).not.toHaveBeenCalled();
  });

  it("rechecks selected number by area, exchange and final four before any charge or order", async () => {
    await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    });
    expect(platform.searchTelnyxNumbers).toHaveBeenCalledWith({
      countryCode: "US",
      areaCode: "202",
      startsWith: "555",
      endsWith: "0200",
      numberType: "local",
      limit: 30,
    });
    expect(platform.orderTelnyxNumber).toHaveBeenCalledTimes(1);
  });

  it("does not order a similar number or reserve credits if the exact number vanishes", async () => {
    platform.searchTelnyxNumbers.mockResolvedValue([{
      phoneNumber: "+12025550201",
      countryCode: "US", administrativeArea: "DC", locality: "Washington",
      numberType: "local", monthlyCost: "1.00", upfrontCost: "0.00",
      currency: "USD", bestEffort: false,
    }]);
    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({ code: "PHONE_NUMBER_UNAVAILABLE", status: 409 });
    expect(platform.searchTelnyxNumbers).toHaveBeenCalledTimes(2);
    expect(platform.orderTelnyxNumber).not.toHaveBeenCalled();
    expect(platform.createTelnyxCallControlApplication).not.toHaveBeenCalled();
    expect(platform.createTelnyxMessagingProfile).not.toHaveBeenCalled();
    expect(await db.select().from(hostedPhoneNumbers)).toHaveLength(0);
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
  });

  it("rejects a changed carrier quote before reserving credits or ordering the number", async () => {
    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 1999,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({
      code: "PHONE_NUMBER_PRICE_CHANGED",
      status: 409,
    });

    expect(platform.orderTelnyxNumber).not.toHaveBeenCalled();
    expect(await db.select().from(hostedPhoneNumbers)).toHaveLength(0);
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
  });

  it("settles a concurrently reconciled carrier activation only once", async () => {
    await db.insert(hostedPhoneNumbers).values({
      workspaceId,
      provider: "telnyx",
      providerOrderId: "order-concurrent",
      providerOrderPhoneNumberId: "order-number-concurrent",
      provisionRequestId: requestId,
      phoneNumber: "+12025550200",
      countryCode: "US",
      numberType: "local",
      status: "PROVISIONING",
      messagingReadiness: "NOT_REGISTERED",
      providerMonthlyCostMicros: 1_000_000,
      providerUpfrontCostMicros: 0,
      monthlyCredits: 2000,
      purchaseCredits: 2000,
      voiceConnectionId: "call-control-1",
      messagingProfileId: "messaging-profile-1",
      reconcileAfter: new Date(0),
    });
    platform.retrieveTelnyxNumberOrder.mockResolvedValue({
      id: "order-concurrent",
      status: "pending",
      requirements_met: true,
    });
    platform.retrieveTelnyxOrderPhoneNumber.mockResolvedValue({
      id: "order-number-concurrent",
      phone_number: "+12025550200",
      status: "success",
      requirements_met: true,
    });

    await Promise.all([
      processPendingPhoneNumberProvisioning(),
      processPendingPhoneNumberProvisioning(),
    ]);

    const [stored] = await db.select().from(hostedPhoneNumbers);
    expect(stored.status).toBe("ACTIVE");
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);
    expect(await db.select().from(usageEvents)).toHaveLength(1);
    expect((await db.select().from(capabilityBindings)).map((row) => row.capability).sort()).toEqual(["SMS", "VOICE"]);
  });

  it("keeps the number provisioning when the order is final but account inventory is not active", async () => {
    platform.findOwnedTelnyxNumber.mockResolvedValue({
      id: "owned-number-pending",
      phone_number: "+12025550200",
      status: "pending",
    });

    const number = await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    });

    expect(number).toMatchObject({
      status: "PROVISIONING",
      messagingReadiness: "NOT_REGISTERED",
    });
    expect((await db.select().from(capabilityBindings))).toHaveLength(0);
    expect((await db.select().from(usageEvents))).toHaveLength(0);
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);
  });

  it("returns an error when a pending carrier order later fails during activation polling", async () => {
    platform.retrieveTelnyxNumberOrder.mockResolvedValue({
      id: "order-1",
      status: "failure",
      requirements_met: true,
    });
    platform.retrieveTelnyxOrderPhoneNumber.mockResolvedValue({
      id: "order-number-1",
      phone_number: "+12025550200",
      status: "failure",
      requirements_met: true,
    });
    platform.findOwnedTelnyxNumber.mockResolvedValue(null);

    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({
      code: "PHONE_NUMBER_ORDER_FAILED",
      status: 409,
    });

    expect((await db.select().from(hostedPhoneNumbers))[0].status).toBe("FAILED");
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
    expect(await db.select().from(usageEvents)).toHaveLength(0);
  });

  it("keeps carrier requirement orders non-active until requirements are actually satisfied", async () => {
    platform.retrieveTelnyxNumberOrder.mockResolvedValue({
      id: "order-1",
      status: "pending",
      requirements_met: false,
    });
    platform.retrieveTelnyxOrderPhoneNumber.mockResolvedValue({
      id: "order-number-1",
      phone_number: "+12025550200",
      status: "pending",
      requirements_met: false,
    });

    const number = await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    });

    expect(number).toMatchObject({ status: "PROVISIONING" });
    expect(number?.failureReason).toBe("Additional carrier activation requirements are still pending.");
    expect((await db.select().from(capabilityBindings))).toHaveLength(0);
    expect((await db.select().from(usageEvents))).toHaveLength(0);
  });

  it("recovers an ambiguous carrier timeout by unique order reference before activation", async () => {
    platform.orderTelnyxNumber.mockRejectedValueOnce(new ProviderRequestError("Provider connection timed out.", 504));
    const number = await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    });

    expect(number).toMatchObject({ status: "RECONCILING" });
    expect(platform.releaseTelnyxNumber).not.toHaveBeenCalled();
    expect(await db.select().from(usageEvents)).toHaveLength(0);
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);

    const [row] = await db.select().from(hostedPhoneNumbers);
    await db.update(hostedPhoneNumbers).set({ reconcileAfter: new Date(0) }).where(eq(hostedPhoneNumbers.id, row.id));
    platform.findTelnyxNumberOrderByReference.mockResolvedValue({
      id: "recovered-order-1",
      status: "pending",
      requirements_met: true,
      customer_reference: `ai-caller:${workspaceId}:${requestId}`,
      phone_numbers: [{
        id: "recovered-order-number-1",
        phone_number: "+12025550200",
      }],
    });
    platform.retrieveTelnyxNumberOrder.mockResolvedValue({
      id: "recovered-order-1",
      status: "pending",
      requirements_met: true,
    });
    platform.retrieveTelnyxOrderPhoneNumber.mockResolvedValue({
      id: "recovered-order-number-1",
      phone_number: "+12025550200",
      status: "success",
      requirements_met: true,
    });

    await expect(processPendingPhoneNumberProvisioning()).resolves.toMatchObject({
      checked: 1,
      activated: 1,
    });

    const [reconciled] = await db.select().from(hostedPhoneNumbers);
    expect(reconciled).toMatchObject({
      status: "ACTIVE",
      providerOrderId: "recovered-order-1",
      providerOrderPhoneNumberId: "recovered-order-number-1",
      providerNumberId: "owned-number-1",
      providerOrderStatus: "pending",
    });
    expect(platform.findTelnyxNumberOrderByReference).toHaveBeenCalledWith({
      workspaceId,
      requestId,
      phoneNumber: "+12025550200",
    });
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);
    expect(await db.select().from(usageEvents)).toHaveLength(1);
  });

  it("fails and returns reserved credits after a prolonged indeterminate purchase has no order or owned number", async () => {
    platform.orderTelnyxNumber.mockRejectedValueOnce(new ProviderRequestError("Provider connection timed out.", 504));
    platform.findOwnedTelnyxNumber.mockResolvedValue(null);
    platform.findTelnyxNumberOrderByReference.mockResolvedValue(null);

    await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    });

    const [row] = await db.select().from(hostedPhoneNumbers);
    await db.update(hostedPhoneNumbers).set({
      createdAt: new Date(Date.now() - 31 * 60_000),
      reconcileAfter: new Date(0),
    }).where(eq(hostedPhoneNumbers.id, row.id));

    await expect(processPendingPhoneNumberProvisioning()).resolves.toMatchObject({
      checked: 1,
      failed: 1,
    });

    const [failed] = await db.select().from(hostedPhoneNumbers);
    expect(failed).toMatchObject({
      status: "FAILED",
      providerOrderStatus: "not_found",
    });
    expect(platform.releaseTelnyxNumber).not.toHaveBeenCalled();
    expect(platform.deleteTelnyxCallControlApplication).toHaveBeenCalledWith("call-control-1");
    expect(platform.deleteTelnyxMessagingProfile).toHaveBeenCalledWith("messaging-profile-1");
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
    expect(await db.select().from(usageEvents)).toHaveLength(0);
  });

  it("preserves BYOP capability routes when the last managed number is released", async () => {
    const [integration] = await db.insert(integrations).values({
      workspaceId,
      category: "COMMUNICATION",
      provider: "telnyx",
      mode: "BYOP",
      status: "CONNECTED",
    }).returning();
    await db.insert(capabilityBindings).values([
      { workspaceId, capability: "VOICE", mode: "BYOP", integrationId: integration.id },
      { workspaceId, capability: "SMS", mode: "BYOP", integrationId: integration.id },
    ]);
    const [number] = await db.insert(hostedPhoneNumbers).values({
      workspaceId,
      provider: "telnyx",
      providerNumberId: "owned-number-release",
      phoneNumber: "+12025550200",
      countryCode: "US",
      numberType: "local",
      status: "ACTIVE",
      messagingReadiness: "READY",
      providerMonthlyCostMicros: 1_000_000,
      providerUpfrontCostMicros: 0,
      monthlyCredits: 2000,
      purchaseCredits: 2000,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      nextBillingAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    }).returning();

    await expect(releaseManagedPhoneNumber(workspaceId, number.id)).resolves.toMatchObject({
      status: "RELEASED",
    });

    const bindings = await db.select().from(capabilityBindings);
    expect(bindings).toHaveLength(2);
    expect(bindings.every((binding) => binding.mode === "BYOP" && binding.integrationId === integration.id)).toBe(true);
  });

  it("rejects idempotent request reuse when confirmed pricing changes", async () => {
    await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    });

    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2001,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({
      code: "PHONE_NUMBER_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    expect(platform.orderTelnyxNumber).toHaveBeenCalledTimes(1);
  });

  it("reports a carrier 400 in exact recheck without reserving credits or creating resources", async () => {
    platform.searchTelnyxNumbers.mockRejectedValueOnce(
      new ProviderRequestError("Bearer secret shouldn't reach browser", 400, "10002", "/phone_number"),
    );
    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({
      code: "TELNYX_NUMBER_PROVISIONING_REJECTED",
      status: 502,
      details: {
        stage: "AVAILABILITY_RECHECK",
        providerStatus: 400,
        providerCode: "10002",
        providerField: "/phone_number",
      },
    });
    expect(platform.createTelnyxCallControlApplication).not.toHaveBeenCalled();
    expect(platform.createTelnyxMessagingProfile).not.toHaveBeenCalled();
    expect(platform.orderTelnyxNumber).not.toHaveBeenCalled();
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
    expect(await db.select().from(hostedPhoneNumbers)).toHaveLength(0);
  });

  it.each([
    ["VOICE_APPLICATION", "createTelnyxCallControlApplication", false],
    ["MESSAGING_PROFILE", "createTelnyxMessagingProfile", true],
    ["NUMBER_ORDER", "orderTelnyxNumber", true],
  ] as const)("reports %s carrier rejection, releases credits, and avoids false activation", async (
    stage, rejectedMethod, expectVoiceCleanup,
  ) => {
    platform[rejectedMethod].mockRejectedValueOnce(
      new ProviderRequestError("Bearer secret shouldn't reach browser", 400, "10002", "/messaging_profile_id"),
    );
    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({
      code: "TELNYX_NUMBER_PROVISIONING_REJECTED",
      status: 502,
      details: { stage, providerStatus: 400, providerCode: "10002" },
    });
    expect(platform.orderTelnyxNumber).toHaveBeenCalledTimes(stage === "NUMBER_ORDER" ? 1 : 0);
    expect(platform.deleteTelnyxCallControlApplication).toHaveBeenCalledTimes(expectVoiceCleanup ? 1 : 0);
    expect(platform.deleteTelnyxMessagingProfile).toHaveBeenCalledTimes(stage === "NUMBER_ORDER" ? 1 : 0);
    expect(platform.releaseTelnyxNumber).not.toHaveBeenCalled();
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
    expect((await db.select().from(hostedPhoneNumbers))[0].status).toBe("FAILED");
  });

  it("preserves a failed outcome on an idempotent retry instead of reporting accepted provisioning", async () => {
    platform.orderTelnyxNumber.mockRejectedValueOnce(new ProviderRequestError("Invalid order", 422));

    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({
      code: "TELNYX_NUMBER_PROVISIONING_REJECTED",
      status: 502,
      details: { stage: "NUMBER_ORDER", providerStatus: 422 },
    });

    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    })).rejects.toMatchObject({
      code: "PHONE_NUMBER_REQUEST_COMPLETE",
      status: 409,
    });
    expect(platform.orderTelnyxNumber).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation and auxiliary resources on a definitive pre-purchase rejection", async () => {
    platform.orderTelnyxNumber.mockRejectedValueOnce(new ProviderRequestError("Invalid order", 422));

    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
      expectedPurchaseCredits: 2000,
      expectedMonthlyCredits: 2000,
    })).rejects.toThrow("Invalid order");

    expect(platform.deleteTelnyxCallControlApplication).toHaveBeenCalledWith("call-control-1");
    expect(platform.deleteTelnyxMessagingProfile).toHaveBeenCalledWith("messaging-profile-1");
    expect(platform.releaseTelnyxNumber).not.toHaveBeenCalled();
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
    expect((await db.select().from(hostedPhoneNumbers))[0].status).toBe("FAILED");
  });
});

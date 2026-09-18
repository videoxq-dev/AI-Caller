import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "@/server/providers/http";

const platform = vi.hoisted(() => ({
  createTelnyxCallControlApplication: vi.fn(async () => "call-control-1"),
  createTelnyxMessagingProfile: vi.fn(async () => "messaging-profile-1"),
  deleteTelnyxCallControlApplication: vi.fn(async () => undefined),
  deleteTelnyxMessagingProfile: vi.fn(async () => undefined),
  findOwnedTelnyxNumber: vi.fn(async () => ({ id: "owned-number-1", phone_number: "+12025550200", status: "active" })),
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
import { capabilityBindings, creditWallets, hostedPhoneNumbers, usageEvents, workspaces } from "@/db/schema";
import { processPendingPhoneNumberProvisioning, provisionManagedPhoneNumber } from "./service";

const requestId = "11111111-1111-4111-8111-111111111111";

describe("managed phone provisioning lifecycle", () => {
  let workspaceId = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    platform.createTelnyxCallControlApplication.mockResolvedValue("call-control-1");
    platform.createTelnyxMessagingProfile.mockResolvedValue("messaging-profile-1");
    platform.deleteTelnyxCallControlApplication.mockResolvedValue(undefined);
    platform.deleteTelnyxMessagingProfile.mockResolvedValue(undefined);
    platform.releaseTelnyxNumber.mockResolvedValue(undefined);
    platform.findOwnedTelnyxNumber.mockResolvedValue({ id: "owned-number-1", phone_number: "+12025550200", status: "active" });
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
      status: "success",
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

  it("waits for final carrier order and ordered-number statuses before activating", async () => {
    const number = await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
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
      providerOrderStatus: "success",
      status: "ACTIVE",
      messagingReadiness: "NOT_REGISTERED",
    });
    expect((await db.select().from(capabilityBindings)).map((row) => row.capability).sort()).toEqual(["SMS", "VOICE"]);
    expect((await db.select().from(usageEvents))).toHaveLength(1);
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);
  });

  it("keeps an ambiguous carrier timeout reconcilable and adopts the number before charging/refunding again", async () => {
    platform.orderTelnyxNumber.mockRejectedValueOnce(new ProviderRequestError("Provider connection timed out.", 504));
    platform.findOwnedTelnyxNumber.mockResolvedValueOnce(null);

    const number = await provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
    });

    expect(number).toMatchObject({ status: "RECONCILING" });
    expect(platform.releaseTelnyxNumber).not.toHaveBeenCalled();
    expect(await db.select().from(usageEvents)).toHaveLength(0);
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);

    const [row] = await db.select().from(hostedPhoneNumbers);
    await db.update(hostedPhoneNumbers).set({ reconcileAfter: new Date(0) }).where(eq(hostedPhoneNumbers.id, row.id));
    platform.findOwnedTelnyxNumber.mockResolvedValue({ id: "owned-number-after-timeout", phone_number: "+12025550200", status: "active" });

    await expect(processPendingPhoneNumberProvisioning()).resolves.toMatchObject({
      checked: 1,
      activated: 1,
    });

    const [reconciled] = await db.select().from(hostedPhoneNumbers);
    expect(reconciled).toMatchObject({
      status: "ACTIVE",
      providerNumberId: "owned-number-after-timeout",
      providerOrderStatus: "reconciled",
    });
    expect((await db.select().from(creditWallets))[0].balance).toBe(8_000);
    expect(await db.select().from(usageEvents)).toHaveLength(1);
  });

  it("releases the reservation and auxiliary resources on a definitive pre-purchase rejection", async () => {
    platform.orderTelnyxNumber.mockRejectedValueOnce(new ProviderRequestError("Invalid order", 422));

    await expect(provisionManagedPhoneNumber(workspaceId, {
      phoneNumber: "+12025550200",
      requestId,
    })).rejects.toThrow("Invalid order");

    expect(platform.deleteTelnyxCallControlApplication).toHaveBeenCalledWith("call-control-1");
    expect(platform.deleteTelnyxMessagingProfile).toHaveBeenCalledWith("messaging-profile-1");
    expect(platform.releaseTelnyxNumber).not.toHaveBeenCalled();
    expect((await db.select().from(creditWallets))[0].balance).toBe(10_000);
    expect((await db.select().from(hostedPhoneNumbers))[0].status).toBe("FAILED");
  });
});

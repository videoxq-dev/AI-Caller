import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, closeDatabase } from "@/db";
import { hostedPhoneNumbers, smsRegistrations, workspaces } from "@/db/schema";
import { reconcileSmsRegistration } from "./registration-service";
import { brandPayload, campaignPayload, tollFreePayload, type TelnyxRegistrationDraft } from "./registration-provider";
import { tenDlcCarrierStatus, tollFreeCarrierStatus } from "./policy";

const draft: TelnyxRegistrationDraft = {
  legalName: "Sarah's Dental", contactName: "Sarah Smith", contactEmail: "contact@example.com",
  contactPhone: "+12025550100", website: "https://example.com",
  privacyPolicyUrl: "https://example.com/privacy", termsUrl: "https://example.com/terms",
  messagingUseCase: "We send appointment booking confirmations and reminders to opted-in patients.",
  optInFlow: "Patients explicitly check the appointment SMS consent box on our website.",
  sampleMessages: ["Your appointment with Sarah's Dental is confirmed.", "Reminder: your appointment is tomorrow."],
  categories: ["TRANSACTIONAL"], allowEmbeddedLinks: true, businessAddress: "123 Main St",
  businessCity: "Austin", businessState: "TX", businessZip: "78701",
  entityType: "PRIVATE_PROFIT", vertical: "HEALTHCARE", ein: "123456789",
  messageVolume: "1,000", optInEvidenceUrl: "https://example.com/optin", stockSymbol: "", stockExchange: "NONE",
};

function carrier(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    createBrand: vi.fn(async () => ({ brandId: "brand-1" })),
    getBrand: vi.fn(async () => ({ brandId: "brand-1", status: "OK", identityStatus: "VERIFIED" })),
    updateBrand: vi.fn(async () => ({ brandId: "brand-1", status: "OK", identityStatus: "VERIFIED" })),
    createCampaign: vi.fn(async () => ({ campaignId: "campaign-1" })),
    getCampaign: vi.fn(async () => ({ campaignId: "campaign-1", submissionStatus: "CREATED", campaignStatus: "MNO_PROVISIONED", usecase: "CUSTOMER_CARE", embeddedLink: true })),
    updateCampaign: vi.fn(async () => ({ campaignId: "campaign-1" })),
    appealCampaign: vi.fn(async () => ({ appealed_at: "2026-09-19T00:00:00Z" })),
    getAssignment: vi.fn(async () => ({ phoneNumber: "+12025550200", campaignId: "campaign-1", assignmentStatus: "ASSIGNED" })),
    assignNumber: vi.fn(async () => ({ phoneNumber: "+12025550200", campaignId: "campaign-1", assignmentStatus: "ASSIGNED" })),
    findTollFreeByNumber: vi.fn(async () => null),
    createTollFree: vi.fn(async () => ({ id: "verification-1" })),
    updateTollFree: vi.fn(async () => ({ id: "verification-1" })),
    getTollFree: vi.fn(async () => ({ id: "verification-1", verificationStatus: "Verified", phoneNumbers: [{ phoneNumber: "+18885550200" }] })),
    ...overrides,
  };
}

describe("Telnyx registration contracts", () => {
  it("sends two-letter states to 10DLC but full state names to toll-free", () => {
    expect(brandPayload(draft).state).toBe("TX");
    expect(tollFreePayload(draft, "+18885550200").businessState).toBe("Texas");
    expect(tollFreePayload(draft, "+18885550200").phoneNumbers).toEqual([{ phoneNumber: "+18885550200" }]);
    expect(campaignPayload(draft, "brand-1", "reference-1").embeddedLink).toBe(true);
    expect(tollFreePayload(draft, "+18885550200").isvReseller).toBe("AI Caller");
    expect(tollFreePayload({ ...draft, categories: ["TRANSACTIONAL", "MARKETING"] }, "+18885550200").useCase).toBe("Mixed");
    expect(tollFreePayload({ ...draft, categories: ["MARKETING"] }, "+18885550200").useCase).toBe("General Marketing");
    expect(campaignPayload({ ...draft, categories: ["MARKETING"] }, "brand-1", "reference-1").usecase).toBe("MARKETING");
  });
  it("fails closed unless the brand, campaign and number assignment all qualify", () => {
    expect(tenDlcCarrierStatus({ brandStatus: "OK", identityStatus: "VERIFIED", submissionStatus: "CREATED", campaignStatus: "MNO_PROVISIONED", assignmentStatus: "ASSIGNED" })).toBe("READY");
    expect(tenDlcCarrierStatus({ brandStatus: "OK", identityStatus: "VERIFIED", submissionStatus: "CREATED", campaignStatus: "MNO_PROVISIONED", assignmentStatus: "PENDING_ASSIGNMENT" })).toBe("PENDING");
    expect(tenDlcCarrierStatus({ brandStatus: "OK", identityStatus: "VERIFIED", submissionStatus: "CREATED", campaignStatus: "MNO_REJECTED", assignmentStatus: "ASSIGNED" })).toBe("REJECTED");
    expect(tollFreeCarrierStatus("Verified")).toBe("READY");
    expect(tollFreeCarrierStatus("Waiting For Customer")).toBe("PENDING");
    expect(tollFreeCarrierStatus("Rejected")).toBe("REJECTED");
  });
});

describe("SMS registration reconciliation", () => {
  let workspaceId = "";
  let registrationId = "";
  let numberId = "";
  async function seed(numberType: "local" | "toll_free", changes: Record<string, unknown> = {}) {
    const phoneNumber = numberType === "local" ? "+12025550200" : "+18885550200";
    const [number] = await db.insert(hostedPhoneNumbers).values({
      workspaceId, phoneNumber, countryCode: "US", numberType, status: "ACTIVE", messagingReadiness: "PENDING",
      providerMonthlyCostMicros: 1000000, purchaseCredits: 1, monthlyCredits: 1,
    }).returning();
    numberId = number.id;
    const [registration] = await db.insert(smsRegistrations).values({
      workspaceId, phoneNumberId: number.id, numberType, status: "SUBMITTING", draft, ...changes,
    }).returning();
    registrationId = registration.id;
  }
  async function current() {
    const [number] = await db.select().from(hostedPhoneNumbers).where(and(eq(hostedPhoneNumbers.workspaceId, workspaceId), eq(hostedPhoneNumbers.id, numberId)));
    const [registration] = await db.select().from(smsRegistrations).where(eq(smsRegistrations.id, registrationId));
    return { number, registration };
  }
  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Registration Test" }).returning();
    workspaceId = workspace.id;
  });
  afterAll(async () => { await closeDatabase(); });

  it("approves 10DLC only after the registered number is assigned to its approved campaign", async () => {
    await seed("local");
    const client = carrier();
    expect(await reconcileSmsRegistration(workspaceId, registrationId, { submitting: true }, client)).toBe("READY");
    const { number, registration } = await current();
    expect(number.messagingReadiness).toBe("READY");
    expect(registration.carrierBrandId).toBe("brand-1");
    expect(registration.carrierCampaignId).toBe("campaign-1");
    expect(registration.approvedPolicy).toMatchObject({ categories: ["TRANSACTIONAL"] });
    await reconcileSmsRegistration(workspaceId, registrationId, {}, client);
    expect(client.createBrand).toHaveBeenCalledTimes(1);
    expect(client.createCampaign).toHaveBeenCalledTimes(1);
  });

  it("continues campaign creation when a pending brand becomes verified", async () => {
    await seed("local", { carrierBrandId: "brand-1", status: "PENDING" });
    const client = carrier({ getBrand: vi.fn(async () => ({ brandId: "brand-1", status: "OK", identityStatus: "VERIFIED" })) });
    expect(await reconcileSmsRegistration(workspaceId, registrationId, {}, client)).toBe("READY");
    expect(client.createCampaign).toHaveBeenCalledTimes(1);
  });

  it("accepts a matching Telnyx campaign ID alongside a distinct upstream TCR campaign ID", async () => {
    await seed("local");
    const client = carrier({ getAssignment: vi.fn(async () => ({
      phoneNumber: "+12025550200", campaignId: "TCR-UPSTREAM-1", tcrCampaignId: "TCR-UPSTREAM-1",
      telnyxCampaignId: "campaign-1", assignmentStatus: "ASSIGNED",
    })) });
    expect(await reconcileSmsRegistration(workspaceId, registrationId, { submitting: true }, client)).toBe("READY");
  });

  it("rejects a campaign assignment for a different phone number", async () => {
    await seed("local");
    const client = carrier({ getAssignment: vi.fn(async () => ({
      phoneNumber: "+12025550201", campaignId: "campaign-1", assignmentStatus: "ASSIGNED",
    })) });
    expect(await reconcileSmsRegistration(workspaceId, registrationId, { submitting: true }, client)).toBe("REJECTED");
    expect((await current()).number.messagingReadiness).toBe("REJECTED");
  });

  it("never grants approval from a campaign without number assignment", async () => {
    await seed("local");
    const client = carrier({ getAssignment: vi.fn(async () => ({ campaignId: "campaign-1", assignmentStatus: "PENDING_ASSIGNMENT" })) });
    expect(await reconcileSmsRegistration(workspaceId, registrationId, { submitting: true }, client)).toBe("PENDING");
    expect((await current()).number.messagingReadiness).toBe("PENDING");
  });

  it("reconciles verified toll-free requests and resubmits corrections to the same request", async () => {
    await seed("toll_free", { carrierVerificationId: "verification-1" });
    const client = carrier();
    expect(await reconcileSmsRegistration(workspaceId, registrationId, { submitting: true }, client)).toBe("READY");
    expect(client.createTollFree).not.toHaveBeenCalled();
    expect(client.updateTollFree).toHaveBeenCalledTimes(1);
    expect((await current()).number.messagingReadiness).toBe("READY");
  });

  it("never grants toll-free readiness if verified carrier request does not include the number", async () => {
    await seed("toll_free", { carrierVerificationId: "verification-1" });
    const client = carrier({ getTollFree: vi.fn(async () => ({ id: "verification-1", verificationStatus: "Verified", phoneNumbers: [] })) });
    expect(await reconcileSmsRegistration(workspaceId, registrationId, {}, client)).toBe("PENDING");
    expect((await current()).number.messagingReadiness).toBe("PENDING");
  });

  it("removes previously approved scope after carrier rejection", async () => {
    await seed("local", { status: "READY", carrierBrandId: "brand-1", carrierCampaignId: "campaign-1", approvedPolicy: { categories: ["TRANSACTIONAL"], allowEmbeddedLinks: true, description: "Appointments" } });
    const client = carrier({ getCampaign: vi.fn(async () => ({ campaignId: "campaign-1", submissionStatus: "CREATED", campaignStatus: "MNO_REJECTED", usecase: "CUSTOMER_CARE", embeddedLink: true, failureReasons: "Carrier rejected website." })) });
    expect(await reconcileSmsRegistration(workspaceId, registrationId, {}, client)).toBe("REJECTED");
    const { number, registration } = await current();
    expect(number.messagingReadiness).toBe("REJECTED");
    expect(registration.approvedPolicy).toBeNull();
    expect(registration.rejectionReason).toContain("website");
  });
});

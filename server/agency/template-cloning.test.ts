import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  agencyWorkspaceTemplateApplications, aiAgents, automationSettings,
  businessHours, businessProfiles, calendarSetupSettings, communicationSetupSettings, creditWallets, faqs,
  hostedPhoneNumbers, licenses, memberships, policies,
  services, setupProgress, user, workspaceCommercialOwners, workspacePlans,
  workspaces,
} from "@/db/schema";
import {
  archiveAgencyTemplate, buildAgencyTemplatePreview, createAgencyTemplate, publishAgencyTemplateVersion,
} from "@/server/agency/templates";
import { markSetupStep, saveAgentSetup, saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { setWorkspaceAgentCapabilities, setWorkspaceAgentStatus } from "@/server/agent/service";
import { getAgencyCloneReadiness } from "./template-readiness";
import { createWorkspaceFromAgencyTemplate } from "./template-cloning";

let buyer = "";
let other = "";
let original = "";
let templateId = "";
const voice = {
  profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
  recordingPolicy: "ANNOUNCE" as const, afterHoursEnabled: true,
};

beforeEach(async () => {
  buyer = randomUUID();
  other = randomUUID();
  await db.insert(user).values([
    { id: buyer, name: "Agency", email: `${buyer}@example.com`, emailVerified: true },
    { id: other, name: "Other", email: `${other}@example.com`, emailVerified: true },
  ]);
  const [ws] = await db.insert(workspaces).values({ name: "Source Clinic" }).returning();
  original = ws.id;
  await db.insert(workspaceCommercialOwners).values({
    workspaceId: original, purchaserUserId: buyer, kind: "PRIMARY",
  });
  await db.insert(memberships).values({ workspaceId: original, userId: buyer, role: "OWNER" });
  await db.insert(licenses).values({
    workspaceId: original, purchaserUserId: buyer, source: "MANUAL",
    externalPurchaseId: randomUUID(), productCode: "AGENCY_50",
    status: "ACTIVE", purchasedAt: new Date(),
  });
  await saveBusinessSetup(original, {
    businessName: "Source Clinic", industry: "Healthcare",
    websiteUrl: "https://source-clinic.example", phone: "+15555550100",
    address: "Private Lane", city: "Sheridan", country: "US",
    timezone: "America/Denver", summary: "Provides dental appointments.",
    completeStep: true,
  });
  await saveAgentSetup(original, {
    name: "Mia", tone: "Warm", primaryGoal: "Book visits", whenUnsure: "Escalate to human",
    openingMessage: "Welcome to {{business_name}}",
    guardrails: ["Never invent pricing"], voice, qualification: { enabled: false, criteria: [] },
    completeStep: true,
  });
  await db.update(aiAgents).set({ status: "ACTIVE" }).where(eq(aiAgents.workspaceId, original));
  await db.insert(services).values({
    workspaceId: original, name: "Checkup", priceText: "$50", durationMinutes: 30,
  });
  await db.insert(faqs).values({ workspaceId: original, question: "Appointments?", answer: "Yes." });
  await db.insert(policies).values({ workspaceId: original, type: "APPOINTMENTS", title: "Bookings", content: "Call first." });
  await db.insert(automationSettings).values({
    workspaceId: original, key: "MISSED_INQUIRY_RECOVERY", enabled: true,
    config: { delayMinutes: 15, channels: ["SMS"], message: "Hello {{name}} from {{business_name}}" },
  });
  await db.insert(creditWallets).values({ workspaceId: original, balance: 25000 });

  const preview = await buildAgencyTemplatePreview(buyer, original);
  const template = await createAgencyTemplate({
    purchaserUserId: buyer, name: "Dental", reviewed: true, snapshot: preview.snapshot,
  });
  templateId = template.id;
});
afterEach(async () => {
  const owned = await db.select({ id: workspaceCommercialOwners.workspaceId }).from(workspaceCommercialOwners)
    .where(eq(workspaceCommercialOwners.purchaserUserId, buyer));
  if (owned.length) await db.delete(workspaces).where(inArray(workspaces.id, owned.map((row) => row.id)));
  for (const id of [other, buyer]) await db.delete(user).where(eq(user.id, id));
});
afterAll(async () => closeDatabase());

describe("create Agency client from immutable template", () => {
  it("creates a tenant-isolated draft with Core-only configuration and zero credits", async () => {
    const created = await createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "Green Dental", templateId,
      version: 1, idempotencyKey: randomUUID(),
    });
    const workspaceId = created.workspaceId;
    expect(created.workspaceName).toBe("Green Dental");
    expect(created.role).toBe("OWNER");
    expect(await db.select().from(workspaceCommercialOwners)
      .where(eq(workspaceCommercialOwners.workspaceId, workspaceId)))
      .toMatchObject([{ purchaserUserId: buyer, kind: "ADDITIONAL" }]);
    expect(await db.select().from(workspacePlans).where(eq(workspacePlans.workspaceId, workspaceId)))
      .toMatchObject([{ planId: "PERSONAL", source: "DEFAULT" }]);
    expect(await db.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)))
      .toMatchObject([{
        businessName: "Green Dental", industry: "Healthcare",
        timezone: "America/Denver", phone: null, address: null,
        websiteUrl: null, city: null, setupCompletedAt: null,
      }]);
    const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, workspaceId));
    expect(agent).toMatchObject({
      name: "Mia", status: "DRAFT", openingMessage: "Welcome to Green Dental",
    });
    expect(agent.id).not.toEqual((await db.select().from(aiAgents)
      .where(eq(aiAgents.workspaceId, original)))[0]?.id);
    expect(agent.behaviorSettings.capabilities).toMatchObject({
      ANSWER_INQUIRY: true, BOOK_APPOINTMENT: false, CHECK_AVAILABILITY: false,
      SEND_SMS: false, RESCHEDULE_APPOINTMENT: false, CANCEL_APPOINTMENT: false,
    });
    expect(await db.select().from(services).where(eq(services.workspaceId, workspaceId)))
      .toMatchObject([{ name: "Checkup", priceText: "$50" }]);
    expect(await db.select().from(faqs).where(eq(faqs.workspaceId, workspaceId)))
      .toMatchObject([{ question: "Appointments?", answer: "Yes." }]);
    expect(await db.select().from(policies).where(eq(policies.workspaceId, workspaceId)))
      .toMatchObject([{ title: "Bookings" }]);
    const recipes = await db.select().from(automationSettings)
      .where(eq(automationSettings.workspaceId, workspaceId));
    expect(recipes).toHaveLength(5);
    expect(recipes.every((recipe) => recipe.enabled === false)).toBe(true);
    expect(recipes.find((recipe) => recipe.key === "MISSED_INQUIRY_RECOVERY")?.config)
      .toMatchObject({ message: "Hello {{name}} from Green Dental" });
    expect(await db.select().from(creditWallets).where(eq(creditWallets.workspaceId, workspaceId)))
      .toMatchObject([{ balance: 0 }]);
    expect(await db.select().from(setupProgress).where(eq(setupProgress.workspaceId, workspaceId)))
      .toHaveLength(0);
    expect(await db.select().from(memberships).where(eq(memberships.workspaceId, workspaceId)))
      .toMatchObject([{ userId: buyer, role: "OWNER" }]);
    expect((await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, original)))[0]?.status)
      .toBe("ACTIVE");
  });

  it("rejects direct activation until the client's own business, AI, channel and credits are ready", async () => {
    const cloned = await createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "Readiness Clinic", templateId,
      version: 1, idempotencyKey: randomUUID(),
    });
    const id = cloned.workspaceId;
    await expect(setWorkspaceAgentStatus(id, "ACTIVE"))
      .rejects.toMatchObject({ code: "AGENCY_CLONE_NOT_READY", status: 409 });
    const first = await getAgencyCloneReadiness(id);
    expect(first).toMatchObject({ templatedClient: true, canActivate: false });
    expect(first?.items.filter((item) => !item.ready).map((item) => item.key))
      .toEqual(expect.arrayContaining(["business", "agent", "communication", "credits"]));
    expect((await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, id)))[0]?.status).toBe("DRAFT");
    expect(await db.select().from(setupProgress).where(eq(setupProgress.workspaceId, id)))
      .toHaveLength(0);

    await saveBusinessSetup(id, {
      businessName: "Readiness Clinic", industry: "Healthcare", timezone: "America/Denver",
      summary: "Clinic-specific approved content", completeStep: true,
    });
    await saveAgentSetup(id, {
      name: "Mia", tone: "Warm", primaryGoal: "Answer questions",
      whenUnsure: "Escalate to human", guardrails: [], voice,
      qualification: { enabled: false, criteria: [] }, completeStep: true,
    });
    await db.insert(communicationSetupSettings).values({
      workspaceId: id,
      settings: {
        voice: { mode: "HOSTED", provider: null },
        sms: { mode: "HOSTED", provider: null },
        whatsapp: { mode: "BYOP", provider: "whatsapp" },
        webchat: { enabled: true },
      },
    });
    await markSetupStep(id, "communication");
    await db.update(creditWallets).set({ balance: 3000 })
      .where(eq(creditWallets.workspaceId, id));
    await expect(setWorkspaceAgentStatus(id, "ACTIVE"))
      .rejects.toMatchObject({ code: "AGENCY_CLONE_NOT_READY" });
    expect((await getAgencyCloneReadiness(id))?.items.find((item) => item.key === "phone"))
      .toMatchObject({ ready: false });

    await db.insert(hostedPhoneNumbers).values({
      workspaceId: id, phoneNumber: `+1${randomInt(2_000_000_000, 9_999_999_999)}`,
      countryCode: "US", status: "ACTIVE", messagingReadiness: "NOT_REGISTERED",
      providerMonthlyCostMicros: 0, monthlyCredits: 10, purchaseCredits: 10,
    });
    expect(await getAgencyCloneReadiness(id)).toMatchObject({ canActivate: true });
    await expect(setWorkspaceAgentStatus(id, "ACTIVE"))
      .resolves.toMatchObject({ status: "ACTIVE" });
    expect(await db.select().from(setupProgress).where(eq(setupProgress.workspaceId, id)))
      .toMatchObject([{ liveCompletedAt: expect.any(Date) }]);
    expect((await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, original)))[0]?.status)
      .toBe("ACTIVE");
  });

  it("requires destination calendar only for enabled booking actions, and approved SMS only if SMS is enabled", async () => {
    const cloned = await createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "Capability Clinic", templateId,
      version: 1, idempotencyKey: randomUUID(),
    });
    const id = cloned.workspaceId;
    await saveBusinessSetup(id, {
      businessName: "Capability Clinic", timezone: "America/Denver", completeStep: true,
      hours: [{ dayOfWeek: 1, enabled: true, openTime: "09:00", closeTime: "17:00" }],
    });
    await saveAgentSetup(id, {
      name: "Mia", tone: "Warm", primaryGoal: "Book visits",
      whenUnsure: "Escalate to human", guardrails: [], voice,
      qualification: { enabled: false, criteria: [] }, completeStep: true,
    });
    await db.insert(communicationSetupSettings).values({
      workspaceId: id, settings: {
        voice: { mode: "HOSTED", provider: null }, sms: { mode: "HOSTED", provider: null },
        whatsapp: { mode: "BYOP", provider: "whatsapp" }, webchat: { enabled: true },
      },
    });
    await markSetupStep(id, "communication");
    await db.insert(hostedPhoneNumbers).values({
      workspaceId: id, phoneNumber: `+1${randomInt(2_000_000_000, 9_999_999_999)}`,
      countryCode: "US", status: "ACTIVE", messagingReadiness: "NOT_REGISTERED",
      providerMonthlyCostMicros: 0, monthlyCredits: 10, purchaseCredits: 10,
    });
    await db.update(creditWallets).set({ balance: 1000 }).where(eq(creditWallets.workspaceId, id));
    await setWorkspaceAgentCapabilities(id, {
      ...defaultAgentCapabilities, BOOK_APPOINTMENT: true, CHECK_AVAILABILITY: true,
      SEND_SMS: false, RESCHEDULE_APPOINTMENT: false, CANCEL_APPOINTMENT: false,
    });
    const before = await getAgencyCloneReadiness(id);
    expect(before?.items.find((item) => item.key === "calendar")).toMatchObject({ ready: false });
    await expect(setWorkspaceAgentStatus(id, "ACTIVE"))
      .rejects.toMatchObject({ code: "AGENCY_CLONE_NOT_READY" });

    await db.insert(calendarSetupSettings).values({ workspaceId: id, settings: {
      provider: "google", timezone: "America/Denver",
      availableDays: ["Mon"], startTime: "09:00", endTime: "17:00",
    } });
    await markSetupStep(id, "calendar");
    expect((await getAgencyCloneReadiness(id))?.items.find((item) => item.key === "calendar"))
      .toMatchObject({ ready: true });
    await setWorkspaceAgentCapabilities(id, {
      ...defaultAgentCapabilities, BOOK_APPOINTMENT: true, CHECK_AVAILABILITY: true,
      RESCHEDULE_APPOINTMENT: false, CANCEL_APPOINTMENT: false, SEND_SMS: true,
    });
    expect((await getAgencyCloneReadiness(id))?.items.find((item) => item.key === "sms"))
      .toMatchObject({ ready: false });
    await expect(setWorkspaceAgentStatus(id, "ACTIVE"))
      .rejects.toMatchObject({ code: "AGENCY_CLONE_NOT_READY" });
  });

  it("creates just one client when the same request is retried concurrently", async () => {
    const input = {
      purchaserUserId: buyer, name: "Same Request", templateId,
      version: 1, idempotencyKey: randomUUID(),
    };
    const [first, second] = await Promise.all([
      createWorkspaceFromAgencyTemplate(input), createWorkspaceFromAgencyTemplate(input),
    ]);
    expect(first.workspaceId).toBe(second.workspaceId);
    expect(await db.select().from(agencyWorkspaceTemplateApplications)
      .where(eq(agencyWorkspaceTemplateApplications.purchaserUserId, buyer))).toHaveLength(1);
    const owned = await db.select().from(workspaceCommercialOwners)
      .where(eq(workspaceCommercialOwners.purchaserUserId, buyer));
    expect(owned).toHaveLength(2);
    await expect(createWorkspaceFromAgencyTemplate({ ...input, name: "Different Request" }))
      .rejects.toMatchObject({ code: "AGENCY_TEMPLATE_REQUEST_CONFLICT", status: 409 });
    await archiveAgencyTemplate(buyer, templateId);
    expect((await createWorkspaceFromAgencyTemplate(input)).workspaceId).toBe(first.workspaceId);
    await expect(createWorkspaceFromAgencyTemplate({
      ...input, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "AGENCY_TEMPLATE_NOT_FOUND", status: 404 });
  });

  it("uses exact immutable versions; later edits cannot change older clients", async () => {
    const sourceTemplate = await buildAgencyTemplatePreview(buyer, original);
    const first = await createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "First Clinic", templateId,
      version: 1, idempotencyKey: randomUUID(),
    });
    await publishAgencyTemplateVersion({
      purchaserUserId: buyer, templateId, expectedVersion: 1, reviewed: true,
      snapshot: { ...sourceTemplate.snapshot, agent: { ...sourceTemplate.snapshot.agent, name: "New Assistant" } },
    });
    const second = await createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "Second Clinic", templateId,
      version: 2, idempotencyKey: randomUUID(),
    });
    expect((await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, first.workspaceId)))[0]?.name)
      .toBe("Mia");
    expect((await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, second.workspaceId)))[0]?.name)
      .toBe("New Assistant");
    const applications = await db.select().from(agencyWorkspaceTemplateApplications)
      .where(eq(agencyWorkspaceTemplateApplications.purchaserUserId, buyer));
    expect(applications.map((application) => application.templateVersion).sort()).toEqual([1, 2]);
  });

  it("rejects cross-Agency use and prevents capacity bypass at a full 50-client allowance", async () => {
    await expect(createWorkspaceFromAgencyTemplate({
      purchaserUserId: other, name: "Stolen", templateId, version: 1, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "AGENCY_TEMPLATE_NOT_FOUND", status: 404 });

    const full = await db.insert(workspaces).values(
      Array.from({ length: 50 }, (_, index) => ({ name: `Existing Client ${index}` })),
    ).returning({ id: workspaces.id });
    await db.insert(workspaceCommercialOwners).values(full.map((workspace) => ({
      workspaceId: workspace.id, purchaserUserId: buyer, kind: "ADDITIONAL" as const,
    })));
    await expect(createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "Over Capacity", templateId, version: 1, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "WORKSPACE_LIMIT_REACHED", status: 403 });
    expect(await db.select().from(agencyWorkspaceTemplateApplications)
      .where(eq(agencyWorkspaceTemplateApplications.purchaserUserId, buyer))).toHaveLength(0);
  });

  it("keeps existing clones after Agency revocation and blocks new cloning", async () => {
    const created = await createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "Existing", templateId,
      version: 1, idempotencyKey: randomUUID(),
    });
    await db.update(licenses).set({ status: "REFUNDED" })
      .where(eq(licenses.purchaserUserId, buyer));
    await expect(createWorkspaceFromAgencyTemplate({
      purchaserUserId: buyer, name: "New", templateId, version: 1, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "AGENCY_REQUIRED", status: 403 });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, created.workspaceId)))
      .toMatchObject([{ name: "Existing", status: "ACTIVE" }]);
  });
});

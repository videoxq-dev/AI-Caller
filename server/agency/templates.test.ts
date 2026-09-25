import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  agencyWorkspaceTemplateVersions, agencyWorkspaceTemplates, aiAgents,
  automationSettings, creditWallets, licenses, user,
  workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { saveAgentSetup, saveBusinessSetup, createFAQ, createPolicy, createService } from "@/server/domain/onboarding/repository";
import {
  archiveAgencyTemplate, buildAgencyTemplatePreview, createAgencyTemplate,
  getAgencyTemplateVersion, listAgencyTemplates, publishAgencyTemplateVersion,
} from "./templates";
import { parseAgencyTemplateSnapshot } from "./template-schema";

let buyer = "";
let other = "";
let source = "";
const sampleVoice = {
  profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
  recordingPolicy: "ANNOUNCE" as const, afterHoursEnabled: true,
};

beforeEach(async () => {
  buyer = randomUUID();
  other = randomUUID();
  await db.insert(user).values([
    { id: buyer, email: `${buyer}@example.com`, name: "Agency", emailVerified: true },
    { id: other, email: `${other}@example.com`, name: "Other", emailVerified: true },
  ]);
  const [row] = await db.insert(workspaces).values({ name: "Source Business" }).returning();
  source = row.id;
  await db.insert(workspaceCommercialOwners).values({
    workspaceId: source, purchaserUserId: buyer, kind: "PRIMARY",
  });
  await db.insert(licenses).values({
    workspaceId: source, purchaserUserId: buyer, source: "MANUAL",
    externalPurchaseId: randomUUID(), productCode: "AGENCY_50",
    status: "ACTIVE", purchasedAt: new Date(),
  });
});
afterEach(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, source));
  for (const id of [buyer, other]) await db.delete(user).where(eq(user.id, id));
});
afterAll(async () => closeDatabase());

describe("Agency template foundation", () => {
  it("extracts only reusable configuration and sanitizes destination-bound recipes", async () => {
    await saveBusinessSetup(source, {
      businessName: "Private Clinic", industry: "Healthcare", websiteUrl: "https://private-clinic.example",
      phone: "+15555550100", address: "1 Private Lane", city: "Sheridan",
      state: "Wyoming", country: "US", timezone: "America/Denver",
      summary: "Offers dental appointments.",
      hours: [{ dayOfWeek: 1, enabled: true, openTime: "09:00", closeTime: "17:00" }],
      completeStep: true,
    });
    await saveAgentSetup(source, {
      name: "Mia", tone: "Helpful", primaryGoal: "Book visits",
      whenUnsure: "Escalate to a human", openingMessage: "Hello {{business_name}}",
      advancedInstructions: "Use approved FAQs only.",
      guardrails: ["Never invent pricing"], voice: sampleVoice,
      qualification: { enabled: true, criteria: [{ id: "intent", label: "Intent", question: "What service?", required: true }] },
      completeStep: true,
    });
    await db.update(aiAgents).set({
      status: "ACTIVE",
      behaviorSettings: {
        guardrails: ["Never invent pricing"],
        voice: sampleVoice,
        qualification: { enabled: true, criteria: [{ id: "intent", label: "Intent", question: "What service?", required: true }] },
        capabilities: { ...defaultAgentCapabilities, BOOK_APPOINTMENT: false },
        providerApiKey: "sk_live_PRIVATE_SHOULD_NOT_COPY",
        sourceOwnerUserId: buyer,
      },
    }).where(eq(aiAgents.workspaceId, source));
    await createService(source, { name: "Consultation", description: "Initial visit", priceText: "$50", durationMinutes: 30, active: true });
    await createFAQ(source, { question: "Do you accept appointments?", answer: "Yes.", active: true });
    await createPolicy(source, { type: "APPOINTMENTS", title: "Booking", content: "Call before arriving." });
    await db.insert(automationSettings).values({
      workspaceId: source, key: "QUALIFIED_LEAD_ASSIGNMENT", enabled: true,
      config: { assignedUserId: buyer, notifyInApp: true, internalSecret: "sk_live_SHOULD_NOT_COPY" },
    });
    await db.insert(creditWallets).values({ workspaceId: source, balance: 45678 });

    const preview = await buildAgencyTemplatePreview(buyer, source);
    const snapshot = preview.snapshot;
    expect(snapshot.business).toMatchObject({
      industry: "Healthcare", summary: "Offers dental appointments.",
      timezone: "America/Denver",
    });
    expect(snapshot.agent).toMatchObject({ name: "Mia", openingMessage: "Hello {{business_name}}" });
    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.faqs).toHaveLength(1);
    expect(snapshot.policies).toHaveLength(1);
    expect(snapshot.recipes.find((recipe) => recipe.key === "QUALIFIED_LEAD_ASSIGNMENT"))
      .toMatchObject({ config: { assignedUserId: null } });
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of [
      source, buyer, "Private Clinic", "https://private-clinic.example",
      "+15555550100", "1 Private Lane", "sk_live_PRIVATE_SHOULD_NOT_COPY",
      "45678", '"status":"ACTIVE"', '"capabilities":',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("rejects unsupported fields and credentials even when the caller bypasses the preview", async () => {
    const snapshot = (await buildReadyPreview()).snapshot;
    expect(() => parseAgencyTemplateSnapshot({
      ...snapshot, ownerUserId: other,
    })).toThrow(/invalid or unsupported Core configuration/);
    expect(() => parseAgencyTemplateSnapshot({
      ...snapshot, agent: { ...snapshot.agent, advancedInstructions: "sk_live_PRIVATEKEY" },
    })).toThrow(/Remove credentials/);
    expect(() => parseAgencyTemplateSnapshot({
      ...snapshot, recipes: [
        { key: "HUMAN_ESCALATION", config: { assignedUserId: buyer, notifyInApp: true } },
      ],
    }).recipes[0]).not.toThrow();
    expect(parseAgencyTemplateSnapshot({
      ...snapshot, recipes: [
        { key: "HUMAN_ESCALATION", config: { assignedUserId: buyer, notifyInApp: true } },
      ],
    }).recipes[0].config).toMatchObject({ assignedUserId: null });
  });

  it("requires explicit review and keeps older versions immutable on edits", async () => {
    const snapshot = (await buildReadyPreview()).snapshot;
    await expect(createAgencyTemplate({
      purchaserUserId: buyer, name: "Dental", reviewed: false, snapshot,
    })).rejects.toMatchObject({ code: "AGENCY_TEMPLATE_REVIEW_REQUIRED", status: 400 });
    const template = await createAgencyTemplate({
      purchaserUserId: buyer, name: "Dental", reviewed: true, snapshot,
    });
    expect(template.currentVersion).toBe(1);
    expect((await listAgencyTemplates(buyer))).toHaveLength(1);
    const first = await getAgencyTemplateVersion(buyer, template.id, 1);
    expect(first.snapshot.agent.name).toBe("Mia");

    const updated = await publishAgencyTemplateVersion({
      purchaserUserId: buyer, templateId: template.id, expectedVersion: 1,
      name: "Dental", reviewed: true,
      snapshot: { ...snapshot, agent: { ...snapshot.agent, name: "Mia Two" } },
    });
    expect(updated.currentVersion).toBe(2);
    expect((await getAgencyTemplateVersion(buyer, template.id, 1)).snapshot.agent.name).toBe("Mia");
    expect((await getAgencyTemplateVersion(buyer, template.id)).snapshot.agent.name).toBe("Mia Two");
    expect(await db.select().from(agencyWorkspaceTemplateVersions)
      .where(eq(agencyWorkspaceTemplateVersions.templateId, template.id))).toHaveLength(2);
    await expect(publishAgencyTemplateVersion({
      purchaserUserId: buyer, templateId: template.id, expectedVersion: 1, reviewed: true, snapshot,
    })).rejects.toMatchObject({ code: "AGENCY_TEMPLATE_VERSION_CONFLICT", status: 409 });

    await archiveAgencyTemplate(buyer, template.id);
    expect(await listAgencyTemplates(buyer)).toHaveLength(0);
    expect(await db.select().from(agencyWorkspaceTemplates)
      .where(eq(agencyWorkspaceTemplates.id, template.id))).toMatchObject([{ status: "ARCHIVED" }]);
    expect((await getAgencyTemplateVersion(buyer, template.id, 1)).snapshot.agent.name).toBe("Mia");
  });

  it("isolates template reads and writes by commercial purchaser and active Agency license", async () => {
    const snapshot = (await buildReadyPreview()).snapshot;
    const template = await createAgencyTemplate({
      purchaserUserId: buyer, name: "Clinic", reviewed: true, snapshot,
    });
    await expect(getAgencyTemplateVersion(other, template.id))
      .rejects.toMatchObject({ code: "AGENCY_TEMPLATE_NOT_FOUND", status: 404 });
    await expect(buildAgencyTemplatePreview(other, source))
      .rejects.toMatchObject({ code: "AGENCY_WORKSPACE_NOT_MANAGED", status: 404 });
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.purchaserUserId, buyer));
    await expect(createAgencyTemplate({
      purchaserUserId: buyer, name: "Another", reviewed: true, snapshot,
    })).rejects.toMatchObject({ code: "AGENCY_REQUIRED", status: 403 });
  });
});

async function buildReadyPreview() {
  await saveAgentSetup(source, {
    name: "Mia", tone: "Helpful", primaryGoal: "Answer questions",
    whenUnsure: "Escalate to a human", voice: sampleVoice,
    qualification: { enabled: false, criteria: [] }, guardrails: [], completeStep: true,
  });
  return buildAgencyTemplatePreview(buyer, source);
}

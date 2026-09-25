import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  aiAgents, creditWallets, faqs, licenses, memberships,
  user, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { setWorkspaceAgentStatus } from "./service";
import {
  confirmTemplateClientManualReview, getTemplateClientActivationReadiness,
} from "./template-activation-readiness";
import { createAgencyTemplate } from "@/server/agency/templates";
import { createWorkspaceFromAgencyTemplate } from "@/server/agency/template-cloning";
import { saveAgentSetup, saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { getWorkspaceIntegrationEntitlements } from "@/server/commerce/workspace-entitlements";
import { getWorkspaceAgent } from "./service";

let buyer = "";
let staff = "";
let originalId = "";
let cloneId = "";
const voice = {
  profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
  recordingPolicy: "ANNOUNCE" as const, afterHoursEnabled: true,
};

beforeEach(async () => {
  buyer = randomUUID(); staff = randomUUID();
  await db.insert(user).values([
    { id: buyer, name: "Agency", email: `${buyer}@example.com`, emailVerified: true },
    { id: staff, name: "Staff", email: `${staff}@example.com`, emailVerified: true },
  ]);
  const [original] = await db.insert(workspaces).values({ name: "Agency Original" }).returning();
  originalId = original.id;
  await db.insert(workspaceCommercialOwners).values({
    workspaceId: originalId, purchaserUserId: buyer, kind: "PRIMARY",
  });
  await db.insert(memberships).values({ workspaceId: originalId, userId: buyer, role: "OWNER" });
  await db.insert(licenses).values(
    (["AGENCY_50", "UNLIMITED", "PERFORMANCE"] as const).map((code) => ({
      workspaceId: originalId, purchaserUserId: buyer,
      source: "MANUAL" as const, externalPurchaseId: randomUUID(),
      productCode: code, status: "ACTIVE" as const, purchasedAt: new Date(),
    })),
  );
  const template = await createAgencyTemplate({
    purchaserUserId: buyer, name: "Client Starter", reviewed: true,
    snapshot: {
      schemaVersion: 1,
      business: { industry: "Cleaning", summary: "Commercial services", timezone: "UTC", hours: [] },
      agent: {
        name: "Mia", tone: "Friendly", primaryGoal: "Answer inquiries", whenUnsure: "Escalate",
        guardrails: [], voice, qualification: { enabled: false, criteria: [] },
      },
      services: [], faqs: [], policies: [], recipes: [],
    },
  });
  const created = await createWorkspaceFromAgencyTemplate({
    purchaserUserId: buyer, name: "Client Business",
    templateId: template.id, version: 1, idempotencyKey: randomUUID(),
  });
  cloneId = created.workspaceId;
  await db.insert(memberships).values({ workspaceId: cloneId, userId: staff, role: "STAFF" });
});
afterEach(async () => {
  const owned = await db.select({ id: workspaceCommercialOwners.workspaceId })
    .from(workspaceCommercialOwners).where(eq(workspaceCommercialOwners.purchaserUserId, buyer));
  if (owned.length) await db.delete(workspaces).where(inArray(workspaces.id, owned.map((row) => row.id)));
  for (const id of [staff, buyer]) await db.delete(user).where(eq(user.id, id));
});
afterAll(async () => closeDatabase());

async function configureClient() {
  await saveBusinessSetup(cloneId, {
    businessName: "Client Business", timezone: "UTC",
    industry: "Cleaning", summary: "Client-approved services", completeStep: true,
  });
  await saveAgentSetup(cloneId, {
    name: "Mia", tone: "Friendly", primaryGoal: "Answer inquiries",
    whenUnsure: "Escalate", guardrails: [], voice,
    qualification: { enabled: false, criteria: [] }, completeStep: true,
  });
  // This fixture simulates an Agency C allocation. C's transfer/ledger and
  // purchasing rules have independent financial integration coverage.
  await db.update(creditWallets).set({ balance: 250 })
    .where(eq(creditWallets.workspaceId, cloneId));
}

describe("Agency template client activation readiness", () => {
  it("rejects direct activation of an incomplete, unfunded draft", async () => {
    const before = await getTemplateClientActivationReadiness(cloneId);
    expect(before.templated).toBe(true);
    expect(before.missing.map((item) => item.code)).toEqual([
      "BUSINESS_SETUP", "AGENT_SETUP", "AGENCY_CREDITS", "MANUAL_REVIEW",
    ]);
    await expect(setWorkspaceAgentStatus(cloneId, "ACTIVE"))
      .rejects.toMatchObject({ code: "AGENCY_CLIENT_NOT_READY", status: 409 });
    expect((await getWorkspaceAgent(cloneId))?.status).toBe("DRAFT");
    await expect(confirmTemplateClientManualReview(cloneId, buyer))
      .rejects.toMatchObject({ code: "AGENCY_CLIENT_NOT_READY", status: 409 });
  });

  it("permits activation after client setup, Agency credits and explicit review", async () => {
    await configureClient();
    expect((await getTemplateClientActivationReadiness(cloneId)).missing.map((item) => item.code))
      .toEqual(["MANUAL_REVIEW"]);
    await expect(confirmTemplateClientManualReview(cloneId, staff))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const confirmed = await confirmTemplateClientManualReview(cloneId, buyer);
    expect(confirmed.ready).toBe(true);
    expect(confirmed.reviewedAt).toBeInstanceOf(Date);
    await setWorkspaceAgentStatus(cloneId, "ACTIVE");
    expect((await getWorkspaceAgent(cloneId))?.status).toBe("ACTIVE");
    expect((await getTemplateClientActivationReadiness(cloneId)).ready).toBe(true);
    const agent = await getWorkspaceAgent(cloneId);
    expect(agent?.behaviorSettings.capabilities).toMatchObject({
      BOOK_APPOINTMENT: false, CHECK_AVAILABILITY: false, SEND_SMS: false,
    });
  });

  it("invalidates prior review when client-specific agent or knowledge changes", async () => {
    await configureClient();
    await confirmTemplateClientManualReview(cloneId, buyer);
    await db.insert(faqs).values({
      workspaceId: cloneId, question: "New service?", answer: "Call the clinic.",
    });
    expect((await getTemplateClientActivationReadiness(cloneId)).missing)
      .toContainEqual(expect.objectContaining({ code: "MANUAL_REVIEW" }));
    await expect(setWorkspaceAgentStatus(cloneId, "ACTIVE"))
      .rejects.toMatchObject({ code: "AGENCY_CLIENT_NOT_READY" });
    await confirmTemplateClientManualReview(cloneId, buyer);
    await setWorkspaceAgentStatus(cloneId, "ACTIVE");
    await setWorkspaceAgentStatus(cloneId, "PAUSED");
    expect((await getTemplateClientActivationReadiness(cloneId)).ready).toBe(true);
  });

  it("keeps cloned clients Core-only before invitation acceptance and preserves Agency original policy", async () => {
    expect(await getWorkspaceIntegrationEntitlements(originalId)).toMatchObject({
      purchaserUserId: buyer,
      externalCalendar: true,
      agencyByop: true,
      performanceAutomations: true,
    });
    expect(await getWorkspaceIntegrationEntitlements(cloneId)).toMatchObject({
      purchaserUserId: null,
      externalCalendar: false,
      agencyByop: false,
      performanceAutomations: false,
    });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { licenses, memberships, user, workspaceCommercialOwners, workspaces } from "@/db/schema";
import {
  getWorkspaceIntegrationEntitlements,
  requireCapabilityBindingEntitlement,
  requirePerformanceAutomationEntitlement,
  requireProviderIntegrationEntitlement,
} from "./workspace-entitlements";

const users: string[] = [];
const workspaceIds: string[] = [];

async function createBuyer(name: string) {
  const id = randomUUID();
  users.push(id);
  await db.insert(user).values({
    id,
    name,
    email: `${id}@example.com`,
    emailVerified: true,
  });
  return id;
}

async function createOwnedWorkspace(ownerId: string) {
  const [workspace] = await db.insert(workspaces).values({ name: "Entitlement Business" }).returning();
  workspaceIds.push(workspace.id);
  await db.insert(memberships).values({ workspaceId: workspace.id, userId: ownerId, role: "OWNER" });
  return workspace.id;
}

async function grant(userId: string, workspaceId: string, productCode: string, status: "ACTIVE" | "REFUNDED" = "ACTIVE") {
  await db.insert(licenses).values({
    workspaceId,
    purchaserUserId: userId,
    source: "MANUAL",
    externalPurchaseId: randomUUID(),
    productCode,
    status,
    purchasedAt: new Date(),
  });
}

describe("workspace external integration entitlements", () => {
  afterEach(async () => {
    for (const id of workspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
    workspaceIds.length = 0;
    for (const id of users) await db.delete(user).where(eq(user.id, id));
    users.length = 0;
  });

  afterAll(async () => closeDatabase());

  it("gives Core neither external calendars nor BYOP", async () => {
    const owner = await createBuyer("Core Buyer");
    const workspaceId = await createOwnedWorkspace(owner);
    await grant(owner, workspaceId, "CORE");

    await expect(getWorkspaceIntegrationEntitlements(workspaceId)).resolves.toMatchObject({
      purchaserUserId: owner,
      externalCalendar: false,
      nonCalendarByopEnabled: false,
      performanceAutomations: false,
    });
    await expect(requireProviderIntegrationEntitlement(workspaceId, "google"))
      .rejects.toMatchObject({ code: "EXTERNAL_CALENDAR_REQUIRES_UNLIMITED", status: 403 });
    await expect(requireProviderIntegrationEntitlement(workspaceId, "openai"))
      .rejects.toMatchObject({ code: "BYOP_REQUIRES_WHITELABEL", status: 403 });
  });

  it("unlocks calendar providers with Unlimited but does not unlock other BYOP", async () => {
    const owner = await createBuyer("Unlimited Buyer");
    const workspaceId = await createOwnedWorkspace(owner);
    await grant(owner, workspaceId, "CORE");
    await grant(owner, workspaceId, "UNLIMITED");

    await expect(getWorkspaceIntegrationEntitlements(workspaceId)).resolves.toMatchObject({
      externalCalendar: true,
      nonCalendarByopEnabled: false,
      performanceAutomations: false,
    });
    await expect(requireProviderIntegrationEntitlement(workspaceId, "google")).resolves.toBeUndefined();
    await expect(requireProviderIntegrationEntitlement(workspaceId, "calcom")).resolves.toBeUndefined();
    await expect(requireProviderIntegrationEntitlement(workspaceId, "twilio"))
      .rejects.toMatchObject({ code: "BYOP_REQUIRES_WHITELABEL" });
  });

  it("keeps Agency hosted and does not unlock non-calendar BYOP or Unlimited calendars", async () => {
    const owner = await createBuyer("Agency Buyer");
    const workspaceId = await createOwnedWorkspace(owner);
    await grant(owner, workspaceId, "CORE");
    await grant(owner, workspaceId, "AGENCY_50");

    await expect(getWorkspaceIntegrationEntitlements(workspaceId)).resolves.toMatchObject({
      externalCalendar: false,
      nonCalendarByopEnabled: false,
      performanceAutomations: false,
    });
    await expect(requireProviderIntegrationEntitlement(workspaceId, "openrouter"))
      .rejects.toMatchObject({ code: "BYOP_REQUIRES_WHITELABEL" });
    await expect(requireCapabilityBindingEntitlement(workspaceId, "VOICE", "BYOP", "twilio"))
      .rejects.toMatchObject({ code: "BYOP_REQUIRES_WHITELABEL" });
    await expect(requireProviderIntegrationEntitlement(workspaceId, "outlook"))
      .rejects.toMatchObject({ code: "EXTERNAL_CALENDAR_REQUIRES_UNLIMITED" });
  });

  it("does not pass Agency purchaser upgrades to a delegated client owner", async () => {
    const purchaser = await createBuyer("Agency Purchaser");
    const clientOwner = await createBuyer("Delegated Client Owner");
    const originalId = await createOwnedWorkspace(purchaser);
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: originalId, purchaserUserId: purchaser, kind: "PRIMARY",
    });
    for (const product of ["CORE", "UNLIMITED", "PERFORMANCE", "AGENCY_50", "WHITELABEL"]) {
      await grant(purchaser, originalId, product);
    }
    const clientWorkspaceId = await createOwnedWorkspace(purchaser);
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: clientWorkspaceId, purchaserUserId: purchaser, kind: "ADDITIONAL",
    });
    await db.insert(memberships).values({
      workspaceId: clientWorkspaceId, userId: clientOwner, role: "OWNER",
    });

    await expect(getWorkspaceIntegrationEntitlements(clientWorkspaceId)).resolves.toMatchObject({
      purchaserUserId: purchaser,
      externalCalendar: false,
      nonCalendarByopEnabled: false,
      performanceAutomations: false,
      whitelabelEligible: true,
    });
    await expect(requireProviderIntegrationEntitlement(clientWorkspaceId, "google"))
      .rejects.toMatchObject({ code: "EXTERNAL_CALENDAR_REQUIRES_UNLIMITED" });
    await expect(requirePerformanceAutomationEntitlement(clientWorkspaceId))
      .rejects.toMatchObject({ code: "AUTOMATION_BUILDER_REQUIRES_PERFORMANCE" });
    await expect(requireProviderIntegrationEntitlement(clientWorkspaceId, "openrouter"))
      .rejects.toMatchObject({ code: "BYOP_MODE_NOT_CONFIGURED" });
  });

  it("recognizes Whitelabel eligibility on its purchaser's primary business but keeps BYOP dormant until the exclusive mode is implemented", async () => {
    const purchaser = await createBuyer("Whitelabel Purchaser");
    const original = await createOwnedWorkspace(purchaser);
    await db.insert(workspaceCommercialOwners).values({ workspaceId: original, purchaserUserId: purchaser, kind: "PRIMARY" });
    for (const product of ["CORE", "AGENCY_50", "WHITELABEL"]) await grant(purchaser, original, product);
    await expect(getWorkspaceIntegrationEntitlements(original)).resolves.toMatchObject({
      purchaserUserId: purchaser, whitelabelEligible: true, nonCalendarByopEnabled: false,
    });
    await expect(requireProviderIntegrationEntitlement(original, "openai"))
      .rejects.toMatchObject({ code: "BYOP_MODE_NOT_CONFIGURED", status: 403 });
  });

  it("uses a commercial purchaser on a multi-owner primary business without guessing the delegated owner's licenses", async () => {
    const buyer = await createBuyer("Purchaser");
    const delegated = await createBuyer("Delegated");
    const original = await createOwnedWorkspace(buyer);
    await db.insert(workspaceCommercialOwners).values({ workspaceId: original, purchaserUserId: buyer, kind: "PRIMARY" });
    await db.insert(memberships).values({ workspaceId: original, userId: delegated, role: "OWNER" });
    await grant(buyer, original, "UNLIMITED");
    await grant(buyer, original, "PERFORMANCE");
    await expect(getWorkspaceIntegrationEntitlements(original)).resolves.toMatchObject({
      purchaserUserId: buyer, externalCalendar: true, performanceAutomations: true,
    });
    await grant(delegated, original, "WHITELABEL");
    expect((await getWorkspaceIntegrationEntitlements(original)).whitelabelEligible).toBe(false);
  });

  it("keeps WhatsApp embedded signup outside the Agency BYOP gate", async () => {
    const owner = await createBuyer("WhatsApp Core Buyer");
    const workspaceId = await createOwnedWorkspace(owner);
    await grant(owner, workspaceId, "CORE");

    await expect(requireProviderIntegrationEntitlement(workspaceId, "whatsapp")).resolves.toBeUndefined();
    await expect(requireCapabilityBindingEntitlement(workspaceId, "WHATSAPP", "BYOP", "whatsapp")).resolves.toBeUndefined();
  });

  it("unlocks the Automation Builder only with an active Performance purchase", async () => {
    const owner = await createBuyer("Performance Buyer");
    const workspaceId = await createOwnedWorkspace(owner);
    await grant(owner, workspaceId, "CORE");
    await grant(owner, workspaceId, "UNLIMITED");
    await grant(owner, workspaceId, "AGENCY_50");

    await expect(getWorkspaceIntegrationEntitlements(workspaceId)).resolves.toMatchObject({
      performanceAutomations: false,
    });
    await expect(requirePerformanceAutomationEntitlement(workspaceId))
      .rejects.toMatchObject({ code: "AUTOMATION_BUILDER_REQUIRES_PERFORMANCE", status: 403 });

    await grant(owner, workspaceId, "PERFORMANCE");
    await expect(getWorkspaceIntegrationEntitlements(workspaceId)).resolves.toMatchObject({
      performanceAutomations: true,
    });
    await expect(requirePerformanceAutomationEntitlement(workspaceId)).resolves.toBeUndefined();

    await db.update(licenses).set({ status: "REFUNDED" }).where(and(
      eq(licenses.purchaserUserId, owner),
      eq(licenses.productCode, "PERFORMANCE"),
    ));
    await expect(requirePerformanceAutomationEntitlement(workspaceId))
      .rejects.toMatchObject({ code: "AUTOMATION_BUILDER_REQUIRES_PERFORMANCE", status: 403 });
  });

  it("revokes calendar access after Unlimited refund without deleting ownership", async () => {
    const owner = await createBuyer("Refunded Buyer");
    const workspaceId = await createOwnedWorkspace(owner);
    await grant(owner, workspaceId, "UNLIMITED");
    expect((await getWorkspaceIntegrationEntitlements(workspaceId)).externalCalendar).toBe(true);

    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.purchaserUserId, owner));
    await expect(getWorkspaceIntegrationEntitlements(workspaceId)).resolves.toMatchObject({
      purchaserUserId: owner,
      externalCalendar: false,
    });
  });

  it("fails closed for ambiguous ownership and staff-held purchases", async () => {
    const owner = await createBuyer("Owner");
    const other = await createBuyer("Other Buyer");
    const workspaceId = await createOwnedWorkspace(owner);
    await db.insert(memberships).values({ workspaceId, userId: other, role: "STAFF" });
    await grant(other, workspaceId, "UNLIMITED");

    expect((await getWorkspaceIntegrationEntitlements(workspaceId)).externalCalendar).toBe(false);

    await db.update(memberships).set({ role: "OWNER" }).where(eq(memberships.userId, other));
    await grant(owner, workspaceId, "UNLIMITED");
    await expect(getWorkspaceIntegrationEntitlements(workspaceId)).resolves.toEqual({
      purchaserUserId: null,
      externalCalendar: false,
      nonCalendarByopEnabled: false,
      performanceAutomations: false,
      whitelabelEligible: false,
    });
  });
});

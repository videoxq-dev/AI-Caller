import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  capabilityBindings, hostedPhoneNumbers, integrations, smsRegistrations, workspaces,
} from "@/db/schema";
import { smsAutomationReadiness } from "./automation-readiness";

describe("Phase 6C automation SMS readiness", () => {
  let workspaceId = "";
  let otherId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const rows = await db.insert(workspaces).values([
      { name: "SMS automation readiness" },
      { name: "Other workspace" },
    ]).returning();
    workspaceId = rows[0].id;
    otherId = rows[1].id;
  });
  afterAll(async () => { await closeDatabase(); });

  async function hosted(readiness: "NOT_REGISTERED" | "PENDING" | "READY" | "REJECTED" = "NOT_REGISTERED") {
    await db.insert(capabilityBindings).values({ workspaceId, capability: "SMS", mode: "HOSTED" });
    const [number] = await db.insert(hostedPhoneNumbers).values({
      workspaceId, phoneNumber: "+12025550200", countryCode: "US", numberType: "local",
      status: "ACTIVE", messagingReadiness: readiness,
      providerMonthlyCostMicros: 1000000, purchaseCredits: 1, monthlyCredits: 1,
    }).returning();
    return number.id;
  }

  it("does not mistake server SMS authorization for a provisioned sender", async () => {
    const result = await smsAutomationReadiness(workspaceId);
    expect(result).toMatchObject({ status: "NOT_CONFIGURED", categories: [] });
    expect(await smsAutomationReadiness(otherId)).toMatchObject({ status: "NOT_CONFIGURED" });
  });

  it("does not call carrier APIs or need registration to configure and publish an SMS workflow", async () => {
    const id = await hosted();
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "REGISTRATION_REQUIRED", categories: [],
    });
    await db.insert(smsRegistrations).values({
      workspaceId, phoneNumberId: id, numberType: "local", status: "PENDING",
    });
    await db.update(hostedPhoneNumbers).set({ messagingReadiness: "PENDING" })
      .where(eq(hostedPhoneNumbers.id, id));
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "IN_REVIEW", categories: [],
    });
    await db.update(smsRegistrations).set({ status: "REJECTED" })
      .where(eq(smsRegistrations.phoneNumberId, id));
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "REJECTED", categories: [],
    });
  });

  it("reports approved message categories only when both carrier and registration are READY", async () => {
    const id = await hosted("READY");
    const [registration] = await db.insert(smsRegistrations).values({
      workspaceId, phoneNumberId: id, numberType: "local", status: "READY",
      approvedPolicy: { categories: ["TRANSACTIONAL"], allowEmbeddedLinks: false,
        description: "Confirmed bookings only" },
    }).returning();
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "READY", categories: ["TRANSACTIONAL"],
    });
    await db.update(hostedPhoneNumbers).set({ messagingReadiness: "PENDING" })
      .where(eq(hostedPhoneNumbers.id, id));
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "IN_REVIEW", categories: [],
    });
    await db.update(hostedPhoneNumbers).set({ messagingReadiness: "READY" })
      .where(eq(hostedPhoneNumbers.id, id));
    await db.update(smsRegistrations).set({ approvedPolicy: null })
      .where(eq(smsRegistrations.id, registration.id));
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "REGISTRATION_REQUIRED", categories: [],
    });
  });

  it("reads uncommitted SMS registration readiness on the caller's activation transaction", async () => {
    const id = await hosted();
    await db.transaction(async (tx) => {
      await tx.update(hostedPhoneNumbers).set({ messagingReadiness: "READY" })
        .where(eq(hostedPhoneNumbers.id, id));
      await tx.insert(smsRegistrations).values({
        workspaceId, phoneNumberId: id, numberType: "local", status: "READY",
        approvedPolicy: { categories: ["TRANSACTIONAL"], allowEmbeddedLinks: false,
          description: "Confirmed appointments" },
      });
      expect(await smsAutomationReadiness(workspaceId, tx)).toMatchObject({
        status: "READY", categories: ["TRANSACTIONAL"],
      });
    });
  });

  it("treats a suspended managed phone as unavailable even if its carrier campaign is approved", async () => {
    const id = await hosted("READY");
    await db.insert(smsRegistrations).values({
      workspaceId, phoneNumberId: id, numberType: "local", status: "READY",
      approvedPolicy: { categories: ["TRANSACTIONAL"],
        allowEmbeddedLinks: false, description: "Confirmations" },
    });
    await db.update(hostedPhoneNumbers).set({ status: "SUSPENDED" })
      .where(eq(hostedPhoneNumbers.id, id));
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "PHONE_SUSPENDED", categories: [],
    });
  });

  it("does not expose another workspace's approved registration", async () => {
    await hosted();
    const [number] = await db.insert(hostedPhoneNumbers).values({
      workspaceId: otherId, phoneNumber: "+12025550201",
      countryCode: "US", numberType: "local", status: "ACTIVE", messagingReadiness: "READY",
      providerMonthlyCostMicros: 1000000, purchaseCredits: 1, monthlyCredits: 1,
    }).returning();
    await db.insert(smsRegistrations).values({
      workspaceId: otherId, phoneNumberId: number.id, numberType: "local", status: "READY",
      approvedPolicy: { categories: ["TRANSACTIONAL", "MARKETING"],
        allowEmbeddedLinks: true, description: "Other workspace" },
    });
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "REGISTRATION_REQUIRED", categories: [],
    });
    expect(await smsAutomationReadiness(otherId)).toMatchObject({ status: "NOT_CONFIGURED" });
  });

  it("distinguishes connected BYOP from independently verified carrier approval", async () => {
    const [integration] = await db.insert(integrations).values({
      workspaceId, provider: "twilio", category: "COMMUNICATION", mode: "BYOP",
      status: "CONNECTED",
    }).returning();
    await db.insert(capabilityBindings).values({
      workspaceId, capability: "SMS", mode: "BYOP", integrationId: integration.id,
    });
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "CARRIER_UNVERIFIED", categories: [], setupUrl: "/integrations",
    });
    await db.update(integrations).set({ status: "DISCONNECTED" })
      .where(eq(integrations.id, integration.id));
    expect(await smsAutomationReadiness(workspaceId)).toMatchObject({
      status: "PROVIDER_DISCONNECTED", categories: [],
    });
  });
});

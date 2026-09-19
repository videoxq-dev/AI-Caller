import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { hostedPhoneNumbers, smsRegistrations, webchatWidgets, workspaces } from "@/db/schema";
import { getPublicWebchatWidget } from "./repository";

describe("hosted SMS opt-in program selection", () => {
  let workspaceId = "";
  const key = "wc_sms_program_test";
  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "SMS Opt-in Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(webchatWidgets).values({ workspaceId, publicKey: key, enabled: true });
  });
  afterAll(async () => { await closeDatabase(); });

  it("does not advertise marketing approval from a released number", async () => {
    const [previous] = await db.insert(hostedPhoneNumbers).values({
      workspaceId, phoneNumber: "+12025550200", countryCode: "US", numberType: "local",
      status: "RELEASED", releasedAt: new Date(), messagingReadiness: "READY",
      providerMonthlyCostMicros: 1000000, purchaseCredits: 1, monthlyCredits: 1,
    }).returning();
    await db.insert(smsRegistrations).values({
      workspaceId, phoneNumberId: previous.id, numberType: "local", status: "READY",
      draft: { termsUrl: "https://previous.example.com/terms" },
      approvedPolicy: { categories: ["MARKETING"], allowEmbeddedLinks: false, description: "Old promotions" },
    });
    const [current] = await db.insert(hostedPhoneNumbers).values({
      workspaceId, phoneNumber: "+12025550201", countryCode: "US", numberType: "local",
      status: "ACTIVE", messagingReadiness: "PENDING",
      providerMonthlyCostMicros: 1000000, purchaseCredits: 1, monthlyCredits: 1,
    }).returning();
    await db.insert(smsRegistrations).values({
      workspaceId, phoneNumberId: current.id, numberType: "local", status: "PENDING",
      draft: { termsUrl: "https://current.example.com/terms" },
    });

    expect(await getPublicWebchatWidget(key)).toMatchObject({
      smsTermsUrl: "https://current.example.com/terms", marketingProgramApproved: false,
    });

    await db.update(smsRegistrations).set({
      status: "READY",
      approvedPolicy: { categories: ["MARKETING"], allowEmbeddedLinks: true, description: "Current promotions" },
    }).where(and(eq(smsRegistrations.workspaceId, workspaceId), eq(smsRegistrations.phoneNumberId, current.id)));
    await db.update(hostedPhoneNumbers).set({ messagingReadiness: "READY" })
      .where(eq(hostedPhoneNumbers.id, current.id));
    expect((await getPublicWebchatWidget(key))?.marketingProgramApproved).toBe(true);
  });
});

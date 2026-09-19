import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { hostedPhoneNumbers, workspaces } from "@/db/schema";
import { resolveCapability, saveCommunicationSetup } from "./repository";

function communicationInput() {
  return {
    voice: { mode: "HOSTED" as const, provider: null, numberMode: "new" as const, number: "+12025550200" },
    sms: {
      mode: "HOSTED" as const,
      provider: null,
      numberMode: "same" as const,
      number: "+12025550200",
      displayName: "",
      replyWindow: "Always respond",
      afterHoursBehavior: "Auto-reply + collect details",
    },
    whatsapp: { mode: "BYOP" as const, provider: "whatsapp" as const, accountMode: "existing" as const },
    webchat: { enabled: true },
    completeStep: true,
  };
}

describe("managed communication setup", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Managed Communication Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(hostedPhoneNumbers).values({
      workspaceId,
      phoneNumber: "+12025550200",
      countryCode: "US",
      numberType: "local",
      status: "ACTIVE",
      providerMonthlyCostMicros: 1_100_000,
      providerUpfrontCostMicros: 0,
      monthlyCredits: 2200,
      purchaseCredits: 2200,
      provider: "telnyx",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("does not mark communication complete until a managed number is active", async () => {
    await db.delete(hostedPhoneNumbers).where(eq(hostedPhoneNumbers.workspaceId, workspaceId));
    await expect(saveCommunicationSetup(workspaceId, communicationInput())).rejects.toThrow(
      "Choose and activate an AI Caller phone number",
    );
  });

  it("binds voice and SMS as hosted capabilities without customer provider credentials", async () => {
    await expect(saveCommunicationSetup(workspaceId, communicationInput())).resolves.toMatchObject({
      voice: { mode: "HOSTED", provider: null },
      sms: { mode: "HOSTED", provider: null },
    });

    await expect(resolveCapability(workspaceId, "VOICE")).resolves.toMatchObject({
      mode: "HOSTED",
      integration: null,
    });
    await expect(resolveCapability(workspaceId, "SMS")).resolves.toMatchObject({
      mode: "HOSTED",
      integration: null,
    });
  });
});

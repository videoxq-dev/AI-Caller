import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { workspaces } from "@/db/schema";
import { saveCommunicationSetup, saveIntegration, saveVerifiedIntegration } from "./repository";

function communicationInput() {
  return {
    voice: { mode: "HOSTED" as const, provider: null, numberMode: "new" as const, number: "+12025550200" },
    sms: {
      mode: "BYOP" as const,
      provider: "telnyx" as const,
      numberMode: "same" as const,
      number: null,
      displayName: "QA Business",
      replyWindow: "Always respond",
      afterHoursBehavior: "Auto-reply + collect details",
    },
    whatsapp: { mode: "BYOP" as const, provider: "whatsapp" as const, accountMode: "existing" as const },
    webchat: { enabled: true },
    completeStep: true,
  };
}

describe("BYOP SMS setup readiness", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "SMS Readiness Test" }).returning();
    workspaceId = workspace.id;

    await saveVerifiedIntegration(workspaceId, {
      provider: "whatsapp",
      category: "WHATSAPP",
      mode: "BYOP",
      credentials: {},
      settings: {},
    });
    await saveVerifiedIntegration(workspaceId, {
      provider: "telnyx",
      category: "COMMUNICATION",
      mode: "BYOP",
      credentials: { apiKey: "test-key" },
      settings: {},
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("requires a sender number and valid Telnyx webhook public key before completing communication setup", async () => {
    await expect(saveCommunicationSetup(workspaceId, communicationInput())).rejects.toThrow("sender phone number");

    await saveIntegration(workspaceId, {
      provider: "telnyx",
      category: "COMMUNICATION",
      mode: "BYOP",
      credentials: {},
      settings: { phone: "+12025550200" },
    });
    await expect(saveCommunicationSetup(workspaceId, communicationInput())).rejects.toThrow("webhook signing public key");

    await saveIntegration(workspaceId, {
      provider: "telnyx",
      category: "COMMUNICATION",
      mode: "BYOP",
      credentials: {},
      settings: {
        phone: "+12025550200",
        webhookPublicKey: "A".repeat(64),
      },
    });
    await expect(saveCommunicationSetup(workspaceId, communicationInput())).rejects.toThrow("32-byte Ed25519 key");

    await saveIntegration(workspaceId, {
      provider: "telnyx",
      category: "COMMUNICATION",
      mode: "BYOP",
      credentials: {},
      settings: {
        phone: "+12025550200",
        webhookPublicKey: Buffer.alloc(32, 7).toString("base64"),
      },
    });

    await expect(saveCommunicationSetup(workspaceId, communicationInput())).resolves.toMatchObject({
      sms: { mode: "BYOP", provider: "telnyx" },
    });
  });
});

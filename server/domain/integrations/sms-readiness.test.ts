import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { workspaces } from "@/db/schema";
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
  });

  afterAll(async () => {
    await closeDatabase();
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

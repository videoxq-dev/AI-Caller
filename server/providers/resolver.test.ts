import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { capabilityBindings, integrations, workspaces } from "@/db/schema";
import { bindCapability, getIntegration, saveVerifiedIntegration } from "@/server/domain/integrations/repository";
import { resolveProviderRoute } from "./resolver";

let workspaceId = "";

describe("provider capability routing", () => {
  beforeEach(async () => {
    await db.delete(capabilityBindings);
    await db.delete(integrations);
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Provider Routing Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("uses hosted AI when no explicit AI binding exists", async () => {
    const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
    expect(route).toMatchObject({ capability: "AI_TEXT", mode: "HOSTED", provider: "credits", integrationId: null });
  });

  it("resolves a connected BYOP provider and never exposes plaintext secrets", async () => {
    await saveVerifiedIntegration(workspaceId, {
      provider: "openai",
      category: "AI",
      mode: "BYOP",
      credentials: { apiKey: "sk-provider-routing-secret" },
      settings: { model: "gpt-4.1-mini" },
    });
    await bindCapability(workspaceId, "AI_TEXT", "BYOP", "openai");

    const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
    expect(route).toMatchObject({ capability: "AI_TEXT", mode: "BYOP", provider: "openai" });

    const publicIntegration = await getIntegration(workspaceId, "openai");
    expect(publicIntegration).not.toHaveProperty("encryptedCredentials");
    expect(publicIntegration?.maskedCredentials.apiKey).toMatch(/^••••••••/);
    expect(JSON.stringify(publicIntegration)).not.toContain("sk-provider-routing-secret");
  });

  it("rejects providers that do not support the requested capability", async () => {
    await expect(bindCapability(workspaceId, "AI_TEXT", "BYOP", "telnyx")).rejects.toThrow("telnyx cannot be used for AI_TEXT");
  });
});

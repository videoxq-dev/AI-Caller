import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { capabilityBindings, integrations, workspaces } from "@/db/schema";
import {
  bindCapability,
  getIntegration,
  getPrivateIntegration,
  saveIntegration,
  saveVerifiedIntegration,
  setIntegrationStatus,
  testSavedIntegration,
} from "@/server/domain/integrations/repository";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
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
      credentials: { apiKey: "test-provider-routing-secret" },
      settings: { model: "gpt-4.1-mini" },
    });
    await bindCapability(workspaceId, "AI_TEXT", "BYOP", "openai");

    const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
    expect(route).toMatchObject({ capability: "AI_TEXT", mode: "BYOP", provider: "openai" });

    const publicIntegration = await getIntegration(workspaceId, "openai");
    expect(publicIntegration).not.toHaveProperty("encryptedCredentials");
    expect(publicIntegration?.maskedCredentials.apiKey).toMatch(/^••••••••/);
    expect(JSON.stringify(publicIntegration)).not.toContain("test-provider-routing-secret");
  });

  it("redacts provider-echoed credentials from connection errors", async () => {
    const apiKey = "test-echoed-provider-secret";
    await saveIntegration(workspaceId, {
      provider: "openai",
      category: "AI",
      mode: "BYOP",
      credentials: { apiKey },
      settings: {},
    });

    const fetcher = (async () => new Response(JSON.stringify({ error: { message: `Invalid API credential: ${apiKey}` } }), { status: 401 })) as typeof fetch;
    const result = await testSavedIntegration(workspaceId, "openai", fetcher);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(apiKey);

    const publicIntegration = await getIntegration(workspaceId, "openai");
    expect(publicIntegration?.lastError).not.toContain(apiKey);
  });

  it("merges partial credential updates without deleting previously saved secrets", async () => {
    await saveVerifiedIntegration(workspaceId, {
      provider: "twilio",
      category: "COMMUNICATION",
      mode: "BYOP",
      credentials: { sid: "AC123", authToken: "original-secret", phone: "+15550001111" },
      settings: {},
    });

    await saveIntegration(workspaceId, {
      provider: "twilio",
      category: "COMMUNICATION",
      mode: "BYOP",
      credentials: { phone: "+15550002222" },
      settings: {},
    });

    const privateIntegration = await getPrivateIntegration(workspaceId, "twilio");
    const decrypted = decryptIntegrationCredentials<Record<string, string>>(
      privateIntegration!.encryptedCredentials as EncryptedSecretEnvelope,
    );
    expect(decrypted).toEqual({ sid: "AC123", authToken: "original-secret", phone: "+15550002222" });
  });

  it("treats a stale disconnected calendar binding as no external route", async () => {
    await bindCapability(workspaceId, "CALENDAR", "BYOP", "google");

    const [binding] = await db.select().from(capabilityBindings).where(and(
      eq(capabilityBindings.workspaceId, workspaceId),
      eq(capabilityBindings.capability, "CALENDAR"),
    )).limit(1);
    expect(binding).toBeDefined();

    await expect(resolveProviderRoute(workspaceId, "CALENDAR")).resolves.toBeNull();
  });

  it("removes a calendar binding when its provider enters error state", async () => {
    await bindCapability(workspaceId, "CALENDAR", "BYOP", "google");
    await setIntegrationStatus(workspaceId, "google", "ERROR", "expired token");

    const [binding] = await db.select().from(capabilityBindings).where(and(
      eq(capabilityBindings.workspaceId, workspaceId),
      eq(capabilityBindings.capability, "CALENDAR"),
    )).limit(1);
    expect(binding).toBeUndefined();
    await expect(resolveProviderRoute(workspaceId, "CALENDAR")).resolves.toBeNull();
  });

  it("releases the calendar route when a saved provider connection test fails", async () => {
    await saveIntegration(workspaceId, {
      provider: "calcom",
      category: "CALENDAR",
      mode: "BYOP",
      credentials: { apiKey: "bad-calendar-key" },
      settings: {},
    });
    await bindCapability(workspaceId, "CALENDAR", "BYOP", "calcom");

    const fetcher = (async () => new Response(
      JSON.stringify({ error: { message: "Unauthorized" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    const tested = await testSavedIntegration(workspaceId, "calcom", fetcher);

    expect(tested.ok).toBe(false);
    const [binding] = await db.select().from(capabilityBindings).where(and(
      eq(capabilityBindings.workspaceId, workspaceId),
      eq(capabilityBindings.capability, "CALENDAR"),
    )).limit(1);
    expect(binding).toBeUndefined();
    await expect(resolveProviderRoute(workspaceId, "CALENDAR")).resolves.toBeNull();
  });

  it("clears stale capability bindings when an integration is explicitly disconnected", async () => {
    await saveVerifiedIntegration(workspaceId, {
      provider: "openai",
      category: "AI",
      mode: "BYOP",
      credentials: { apiKey: "test-disconnect-secret" },
      settings: {},
    });
    await bindCapability(workspaceId, "AI_TEXT", "BYOP", "openai");
    await setIntegrationStatus(workspaceId, "openai", "DISCONNECTED");

    const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
    expect(route).toMatchObject({ mode: "HOSTED", provider: "credits", integrationId: null });
  });

  it("rejects mismatched integration category and mode", async () => {
    await expect(saveIntegration(workspaceId, {
      provider: "telnyx",
      category: "AI",
      mode: "BYOP",
      credentials: { apiKey: "TEST" },
      settings: {},
    })).rejects.toThrow("telnyx must use the COMMUNICATION integration category");

    await expect(bindCapability(workspaceId, "AI_TEXT", "BYOP", "credits")).rejects.toThrow("hosted AI route");
    await expect(bindCapability(workspaceId, "CALENDAR", "HOSTED")).rejects.toThrow("does not support hosted routing");
  });

  it("rejects providers that do not support the requested capability", async () => {
    await expect(bindCapability(workspaceId, "AI_TEXT", "BYOP", "telnyx")).rejects.toThrow("telnyx cannot be used for AI_TEXT");
  });
});

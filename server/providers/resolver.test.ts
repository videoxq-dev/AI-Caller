import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { capabilityBindings, integrations, licenses, memberships, user, workspaces } from "@/db/schema";
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
const createdUsers: string[] = [];

async function grant(productCode: "UNLIMITED" | "AGENCY_50") {
  const ownerId = randomUUID();
  createdUsers.push(ownerId);
  await db.insert(user).values({ id: ownerId, name: "Provider Buyer", email: `${ownerId}@example.com`, emailVerified: true });
  await db.insert(memberships).values({ workspaceId, userId: ownerId, role: "OWNER" });
  const [license] = await db.insert(licenses).values({
    workspaceId, purchaserUserId: ownerId, source: "MANUAL", externalPurchaseId: randomUUID(),
    productCode, status: "ACTIVE", purchasedAt: new Date(),
  }).returning();
  return license;
}

describe("provider capability routing", () => {
  beforeEach(async () => {
    await db.delete(capabilityBindings);
    await db.delete(integrations);
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Provider Routing Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await db.delete(workspaces);
    for (const id of createdUsers) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("uses hosted AI when no explicit AI binding exists", async () => {
    const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
    expect(route).toMatchObject({ capability: "AI_TEXT", mode: "HOSTED", provider: "credits", integrationId: null });
  });

  it("fails closed for stale Agency BYOP instead of silently charging hosted credits, and never exposes secrets", async () => {
    await grant("AGENCY_50");
    await saveVerifiedIntegration(workspaceId, {
      provider: "openai",
      category: "AI",
      mode: "BYOP",
      credentials: { apiKey: "test-provider-routing-secret" },
      settings: { model: "gpt-4.1-mini" },
    });
    await bindCapability(workspaceId, "AI_TEXT", "BYOP", "openai");

    await expect(resolveProviderRoute(workspaceId, "AI_TEXT"))
      .rejects.toMatchObject({ code: "BYOP_INFRASTRUCTURE_INACTIVE", status: 403 });

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

  it("keeps a connected external calendar route authoritative for Unlimited", async () => {
    await grant("UNLIMITED");
    await saveVerifiedIntegration(workspaceId, {
      provider: "calcom",
      category: "CALENDAR",
      mode: "BYOP",
      credentials: { apiKey: "connected-calendar-key" },
      settings: {},
    });
    await bindCapability(workspaceId, "CALENDAR", "BYOP", "calcom");

    await expect(resolveProviderRoute(workspaceId, "CALENDAR")).resolves.toMatchObject({
      mode: "BYOP",
      provider: "calcom",
    });
  });

  it("falls back to native calendar immediately after Unlimited is refunded", async () => {
    const license = await grant("UNLIMITED");
    await saveVerifiedIntegration(workspaceId, {
      provider: "calcom",
      category: "CALENDAR",
      mode: "BYOP",
      credentials: { apiKey: "refunded-calendar-key" },
      settings: {},
    });
    await bindCapability(workspaceId, "CALENDAR", "BYOP", "calcom");
    await expect(resolveProviderRoute(workspaceId, "CALENDAR")).resolves.toMatchObject({ provider: "calcom" });

    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, license.id));
    await expect(resolveProviderRoute(workspaceId, "CALENDAR")).resolves.toBeNull();
    expect(await getIntegration(workspaceId, "calcom")).toMatchObject({ status: "CONNECTED" });
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

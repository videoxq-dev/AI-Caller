import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { knowledgeSources, licenses, memberships, user, workspaces } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildAgentTestContext } from "@/server/orchestrator/context";
import { deleteKnowledgeSource, getKnowledgeSourceUsage, listKnowledgeSources, saveKnowledgeSource } from "./repository";

describe("workspace-scoped imported knowledge", () => {
  let first = "";
  let second = "";
  const createdUsers: string[] = [];

  async function grantUnlimited(workspaceId: string, uniqueOwner = true) {
    const ownerId = randomUUID();
    createdUsers.push(ownerId);
    await db.insert(user).values({ id: ownerId, name: "Knowledge Buyer", email: `${ownerId}@example.com`, emailVerified: true });
    await db.insert(memberships).values({ workspaceId, userId: ownerId, role: "OWNER" });
    if (!uniqueOwner) {
      const secondId = randomUUID();
      createdUsers.push(secondId);
      await db.insert(user).values({ id: secondId, name: "Co-owner", email: `${secondId}@example.com`, emailVerified: true });
      await db.insert(memberships).values({ workspaceId, userId: secondId, role: "OWNER" });
    }
    const [license] = await db.insert(licenses).values({
      workspaceId, purchaserUserId: ownerId, source: "MANUAL", externalPurchaseId: randomUUID(),
      productCode: "UNLIMITED", status: "ACTIVE", purchasedAt: new Date(),
    }).returning();
    return license;
  }

  afterEach(async () => {
    await db.delete(workspaces);
    for (const id of createdUsers) await db.delete(user).where(eq(user.id, id));
    createdUsers.length = 0;
  });

  beforeEach(async () => {
    await db.delete(workspaces);
    const [a, b] = await db.insert(workspaces).values([
      { name: "Knowledge Alpha" }, { name: "Knowledge Beta" },
    ]).returning();
    first = a.id;
    second = b.id;
  });

  afterAll(async () => { await closeDatabase(); });

  it("updates a repeated website import without duplicating the source and includes it in AI context", async () => {
    await grantUnlimited(first);
    const source = await saveKnowledgeSource(first, {
      kind: "WEBSITE", label: "Company website", sourceUrl: "https://example.com/",
      content: "Opening hours are Monday to Friday.",
    });
    const updated = await saveKnowledgeSource(first, {
      kind: "WEBSITE", label: "Company website", sourceUrl: "https://example.com/",
      content: "Opening hours are Monday to Saturday.",
    });
    expect(updated.id).toBe(source.id);
    expect(await listKnowledgeSources(first)).toHaveLength(1);
    const context = await buildAgentTestContext(first, []);
    expect(context.systemPrompt).toContain("Opening hours are Monday to Saturday.");
    expect(context.systemPrompt).not.toContain("Opening hours are Monday to Friday.");
  });

  it("never exposes or deletes a different workspace's knowledge", async () => {
    await grantUnlimited(first);
    const source = await saveKnowledgeSource(first, {
      kind: "FILE", label: "internal.txt", content: "Workspace Alpha operating hours.",
    });
    expect(await listKnowledgeSources(second)).toEqual([]);
    expect(await deleteKnowledgeSource(second, source.id)).toBeNull();
    expect(await listKnowledgeSources(first)).toHaveLength(1);
    expect(await deleteKnowledgeSource(first, source.id)).toEqual({ id: source.id });
    expect(await listKnowledgeSources(first)).toEqual([]);
  });

  it("allows two imports per Unlimited-owned business and retains sources after refund", async () => {
    const license = await grantUnlimited(first);
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ limit: 2, count: 0, package: "UNLIMITED" });
    for (let i = 0; i < 2; i += 1) {
      await saveKnowledgeSource(first, { kind: "FILE", label: "expanded-" + i, content: "Document " + i });
    }
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 2, limit: 2 });
    await expect(saveKnowledgeSource(first, { kind: "FILE", label: "third", content: "Third" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_SOURCE_LIMIT", status: 409 });
    expect(await getKnowledgeSourceUsage(second)).toMatchObject({ count: 0, limit: 0, package: null });
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, license.id));
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 2, limit: 0, package: null });
    await expect(saveKnowledgeSource(first, { kind: "FILE", label: "after-refund", content: "New" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_IMPORT_REQUIRES_UNLIMITED", status: 403 });
    expect(await listKnowledgeSources(first)).toHaveLength(2);
  });

  it("does not grant Unlimited knowledge to a business with ambiguous ownership", async () => {
    await grantUnlimited(first, false);
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ limit: 0, package: null });
  });

  it("allows updating the same website at the limit but never exceeds two under concurrent imports", async () => {
    await grantUnlimited(first);
    const website = await saveKnowledgeSource(first, {
      kind: "WEBSITE", label: "Original", sourceUrl: "https://example.com/info",
      content: "Original content",
    });
    const attempts = await Promise.allSettled([
      saveKnowledgeSource(first, { kind: "FILE", label: "A", content: "Content A" }),
      saveKnowledgeSource(first, { kind: "FILE", label: "B", content: "Content B" }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 2, limit: 2 });
    const updated = await saveKnowledgeSource(first, {
      kind: "WEBSITE", label: "Updated", sourceUrl: "https://example.com/info",
      content: "Revised content",
    });
    expect(updated.id).toBe(website.id);
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 2 });
    expect(await listKnowledgeSources(first)).toHaveLength(2);
  });

  it("rejects Core imports and updates even when legacy sources already exist", async () => {
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 0, limit: 0, package: null });
    await expect(saveKnowledgeSource(first, {
      kind: "FILE", label: "core.txt", content: "Core cannot upload",
    })).rejects.toMatchObject({ code: "KNOWLEDGE_IMPORT_REQUIRES_UNLIMITED", status: 403 });
    const [legacy] = await db.insert(knowledgeSources).values({
      workspaceId: first, kind: "WEBSITE", label: "Legacy",
      sourceUrl: "https://example.com/", content: "Old", contentHash: "legacy",
    }).returning();
    await expect(saveKnowledgeSource(first, {
      kind: "WEBSITE", label: "Modified", sourceUrl: "https://example.com/", content: "New",
    })).rejects.toMatchObject({ code: "KNOWLEDGE_IMPORT_REQUIRES_UNLIMITED", status: 403 });
    expect(await listKnowledgeSources(first)).toMatchObject([{ id: legacy.id, label: "Legacy" }]);
  });
});

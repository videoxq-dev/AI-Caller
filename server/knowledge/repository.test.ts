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
    const source = await saveKnowledgeSource(first, {
      kind: "FILE", label: "internal.txt", content: "Workspace Alpha operating hours.",
    });
    expect(await listKnowledgeSources(second)).toEqual([]);
    expect(await deleteKnowledgeSource(second, source.id)).toBeNull();
    expect(await listKnowledgeSources(first)).toHaveLength(1);
    expect(await deleteKnowledgeSource(first, source.id)).toEqual({ id: source.id });
    expect(await listKnowledgeSources(first)).toEqual([]);
  });

  it("extends imported knowledge to 500 for an unambiguous Unlimited buyer without granting staff access", async () => {
    const license = await grantUnlimited(first);
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ limit: 500, count: 0, package: "UNLIMITED" });
    for (let i = 0; i < 51; i += 1) {
      await saveKnowledgeSource(first, { kind: "FILE", label: "expanded-" + i, content: "Document " + i });
    }
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 51, limit: 500 });
    expect(await getKnowledgeSourceUsage(second)).toMatchObject({ count: 0, limit: 50, package: null });
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, license.id));
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 51, limit: 50, package: null });
    await expect(saveKnowledgeSource(first, { kind: "FILE", label: "after-refund", content: "New" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_SOURCE_LIMIT", status: 409 });
    expect(await listKnowledgeSources(first, 25, 50)).toHaveLength(1);
  });

  it("does not grant Unlimited knowledge to a business with ambiguous ownership", async () => {
    await grantUnlimited(first, false);
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ limit: 50, package: null });
  });

  it("allows updating the same website at the limit but never exceeds 500 under concurrent imports", async () => {
    await grantUnlimited(first);
    const seeded = Array.from({ length: 498 }, (_, i) => ({
      workspaceId: first, kind: "FILE", label: "seed-" + i,
      content: "Knowledge " + i, contentHash: "hash-" + i,
    }));
    await db.insert(knowledgeSources).values(seeded);
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
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 500, limit: 500 });
    const updated = await saveKnowledgeSource(first, {
      kind: "WEBSITE", label: "Updated", sourceUrl: "https://example.com/info",
      content: "Revised content",
    });
    expect(updated.id).toBe(website.id);
    expect(await getKnowledgeSourceUsage(first)).toMatchObject({ count: 500 });
    expect(await listKnowledgeSources(first, 51)).toHaveLength(50);
    expect(await listKnowledgeSources(first, 50, 450)).toHaveLength(50);
    expect(await listKnowledgeSources(first, 50, 500)).toHaveLength(0);
  });

  it("enforces a bounded number of persisted sources per workspace", async () => {
    for (let i = 0; i < 50; i += 1) {
      await saveKnowledgeSource(first, {
        kind: "FILE", label: "document-" + i + ".txt",
        content: "Knowledge source " + i,
      });
    }
    await expect(saveKnowledgeSource(first, {
      kind: "FILE", label: "overflow.txt", content: "Rejected additional source",
    })).rejects.toThrow("limit: 50");
    expect(await listKnowledgeSources(first, 100)).toHaveLength(50);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { workspaces } from "@/db/schema";
import { buildAgentTestContext } from "@/server/orchestrator/context";
import { deleteKnowledgeSource, listKnowledgeSources, saveKnowledgeSource } from "./repository";

describe("workspace-scoped imported knowledge", () => {
  let first = "";
  let second = "";

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

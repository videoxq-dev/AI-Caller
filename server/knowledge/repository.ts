import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeSources } from "@/db/schema";

export type KnowledgeKind = "WEBSITE" | "FILE";

export function knowledgeHash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function listKnowledgeSources(workspaceId: string, limit = 20) {
  return db.select({
    id: knowledgeSources.id,
    kind: knowledgeSources.kind,
    label: knowledgeSources.label,
    sourceUrl: knowledgeSources.sourceUrl,
    content: knowledgeSources.content,
    contentHash: knowledgeSources.contentHash,
    createdAt: knowledgeSources.createdAt,
    updatedAt: knowledgeSources.updatedAt,
  }).from(knowledgeSources)
    .where(eq(knowledgeSources.workspaceId, workspaceId))
    .orderBy(desc(knowledgeSources.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 50));
}

export async function saveKnowledgeSource(
  workspaceId: string,
  input: { kind: KnowledgeKind; label: string; sourceUrl?: string | null; content: string },
) {
  const content = input.content.trim();
  const contentHash = knowledgeHash(content);
  const existing = input.sourceUrl
    ? await db.select({ id: knowledgeSources.id }).from(knowledgeSources).where(and(
        eq(knowledgeSources.workspaceId, workspaceId),
        eq(knowledgeSources.kind, input.kind),
        eq(knowledgeSources.sourceUrl, input.sourceUrl),
      )).limit(1)
    : [];

  if (existing[0]) {
    const [updated] = await db.update(knowledgeSources).set({
      label: input.label.trim(),
      content,
      contentHash,
      updatedAt: new Date(),
    }).where(and(
      eq(knowledgeSources.workspaceId, workspaceId),
      eq(knowledgeSources.id, existing[0].id),
    )).returning();
    return updated;
  }

  const [created] = await db.insert(knowledgeSources).values({
    workspaceId,
    kind: input.kind,
    label: input.label.trim(),
    sourceUrl: input.sourceUrl ?? null,
    content,
    contentHash,
  }).returning();
  return created;
}

export async function deleteKnowledgeSource(workspaceId: string, sourceId: string) {
  const [deleted] = await db.delete(knowledgeSources).where(and(
    eq(knowledgeSources.workspaceId, workspaceId),
    eq(knowledgeSources.id, sourceId),
  )).returning({ id: knowledgeSources.id });
  return deleted ?? null;
}

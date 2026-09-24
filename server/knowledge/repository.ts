import { createHash } from "node:crypto";
import { AppError } from "@/server/http/errors";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeSources, licenses, memberships } from "@/db/schema";

export type KnowledgeKind = "WEBSITE" | "FILE";
const CORE_SOURCE_LIMIT = 50;
const UNLIMITED_SOURCE_LIMIT = 500;
const LIST_PAGE_LIMIT = 50;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function knowledgeHash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The commercial Unlimited license belongs to the buyer account, not to a
 * staff member of this workspace. Match the existing seat entitlement rule:
 * co-owned businesses are ambiguous until ownership is reconciled.
 */
async function getKnowledgeLimit(tx: Tx, workspaceId: string) {
  const owners = await tx.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "OWNER")))
    .limit(2);
  if (owners.length !== 1) return { limit: CORE_SOURCE_LIMIT, package: null as "UNLIMITED" | null };
  const [unlimited] = await tx.select({ id: licenses.id }).from(licenses).where(and(
    eq(licenses.purchaserUserId, owners[0].userId),
    eq(licenses.productCode, "UNLIMITED"),
    eq(licenses.status, "ACTIVE"),
  )).limit(1);
  return unlimited
    ? { limit: UNLIMITED_SOURCE_LIMIT, package: "UNLIMITED" as const }
    : { limit: CORE_SOURCE_LIMIT, package: null };
}

export async function getKnowledgeSourceUsage(workspaceId: string) {
  return db.transaction(async (tx) => {
    const [entitlement, [total]] = await Promise.all([
      getKnowledgeLimit(tx, workspaceId),
      tx.select({ value: count() }).from(knowledgeSources).where(eq(knowledgeSources.workspaceId, workspaceId)),
    ]);
    return { ...entitlement, count: total?.value ?? 0 };
  });
}

export async function listKnowledgeSources(workspaceId: string, limit = 20, offset = 0) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_PAGE_LIMIT
    || !Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError("KNOWLEDGE_PAGE_INVALID", "Invalid imported knowledge page.", 400);
  }
  return db.select({
    id: knowledgeSources.id,
    kind: knowledgeSources.kind,
    label: knowledgeSources.label,
    sourceUrl: knowledgeSources.sourceUrl,
    contentHash: knowledgeSources.contentHash,
    createdAt: knowledgeSources.createdAt,
    updatedAt: knowledgeSources.updatedAt,
  }).from(knowledgeSources)
    .where(eq(knowledgeSources.workspaceId, workspaceId))
    .orderBy(desc(knowledgeSources.updatedAt), desc(knowledgeSources.id))
    .offset(offset).limit(limit);
}

export async function saveKnowledgeSource(
  workspaceId: string,
  input: { kind: KnowledgeKind; label: string; sourceUrl?: string | null; content: string },
) {
  const content = input.content.trim();
  const contentHash = knowledgeHash(content);
  return db.transaction(async (tx) => {
    // Lock before finding/updating website imports and before the quota count.
    // Two independent imports cannot claim the last slot simultaneously.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`knowledge-source:${workspaceId}`}))`);
    const existing = input.sourceUrl
      ? await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(and(
          eq(knowledgeSources.workspaceId, workspaceId),
          eq(knowledgeSources.kind, input.kind),
          eq(knowledgeSources.sourceUrl, input.sourceUrl),
        )).limit(1)
      : [];

    if (existing[0]) {
      const [updated] = await tx.update(knowledgeSources).set({
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

    const [entitlement, [total]] = await Promise.all([
      getKnowledgeLimit(tx, workspaceId),
      tx.select({ value: count() }).from(knowledgeSources).where(eq(knowledgeSources.workspaceId, workspaceId)),
    ]);
    if ((total?.value ?? 0) >= entitlement.limit) {
      throw new AppError(
        "KNOWLEDGE_SOURCE_LIMIT",
        `Remove an existing knowledge source before importing more (limit: ${entitlement.limit}).`,
        409,
      );
    }

    const [created] = await tx.insert(knowledgeSources).values({
      workspaceId,
      kind: input.kind,
      label: input.label.trim(),
      sourceUrl: input.sourceUrl ?? null,
      content,
      contentHash,
    }).returning();
    return created;
  });
}

export async function deleteKnowledgeSource(workspaceId: string, sourceId: string) {
  const [deleted] = await db.delete(knowledgeSources).where(and(
    eq(knowledgeSources.workspaceId, workspaceId),
    eq(knowledgeSources.id, sourceId),
  )).returning({ id: knowledgeSources.id });
  return deleted ?? null;
}

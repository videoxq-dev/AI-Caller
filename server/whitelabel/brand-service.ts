import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  whitelabelBrandAssets, whitelabelBrands, whitelabelBrandVersions,
} from "@/db/schema";
import { requireEffectiveWhitelabelPurchaser } from "@/server/auth/commercial-ownership";
import { AppError } from "@/server/http/errors";
import {
  brandDraftSchema, brandPublishSchema, DEFAULT_BRAND_DRAFT,
  type BrandDraft, type PublishedBrand,
} from "./brand-schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function ensureBrand(tx: Tx | typeof db, purchaserUserId: string) {
  await tx.insert(whitelabelBrands).values({
    purchaserUserId,
    draft: DEFAULT_BRAND_DRAFT,
  }).onConflictDoNothing({ target: whitelabelBrands.purchaserUserId });
  const [brand] = await tx.select().from(whitelabelBrands)
    .where(eq(whitelabelBrands.purchaserUserId, purchaserUserId)).limit(1);
  if (!brand) throw new Error("Whitelabel brand could not be created.");
  return brand;
}

function parseDraft(value: Record<string, unknown>): BrandDraft {
  const parsed = brandDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_BRAND_DRAFT;
}

function parsePublished(value: Record<string, unknown>): PublishedBrand {
  const parsed = brandPublishSchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored published brand is invalid.");
  return parsed.data;
}

async function loadState(purchaserUserId: string) {
  const brand = await ensureBrand(db, purchaserUserId);
  const versions = await db.select({
    version: whitelabelBrandVersions.version,
    publishedAt: whitelabelBrandVersions.publishedAt,
    publishedByUserId: whitelabelBrandVersions.publishedByUserId,
  }).from(whitelabelBrandVersions)
    .where(eq(whitelabelBrandVersions.brandId, brand.id))
    .orderBy(desc(whitelabelBrandVersions.version));

  let published: PublishedBrand | null = null;
  if (brand.publishedVersion) {
    const [row] = await db.select({ snapshot: whitelabelBrandVersions.snapshot })
      .from(whitelabelBrandVersions)
      .where(and(
        eq(whitelabelBrandVersions.brandId, brand.id),
        eq(whitelabelBrandVersions.version, brand.publishedVersion),
      )).limit(1);
    published = row ? parsePublished(row.snapshot) : null;
  }
  return {
    brandId: brand.id,
    draft: parseDraft(brand.draft),
    revision: brand.revision,
    publishedVersion: brand.publishedVersion,
    published,
    versions,
  };
}

export async function ensureBrandForPurchaser(purchaserUserId: string) {
  await requireEffectiveWhitelabelPurchaser(purchaserUserId);
  return ensureBrand(db, purchaserUserId);
}

export async function getBrandState(purchaserUserId: string) {
  await requireEffectiveWhitelabelPurchaser(purchaserUserId);
  return loadState(purchaserUserId);
}

async function assertAssetsBelongToBrand(tx: Tx, brandId: string, draft: BrandDraft) {
  const ids = [draft.logoAssetId, draft.iconAssetId, draft.faviconAssetId]
    .filter((value): value is string => Boolean(value));
  if (!ids.length) return;
  const assets = await tx.select({
    id: whitelabelBrandAssets.id,
    kind: whitelabelBrandAssets.kind,
  }).from(whitelabelBrandAssets).where(and(
    eq(whitelabelBrandAssets.brandId, brandId),
    inArray(whitelabelBrandAssets.id, ids),
    isNull(whitelabelBrandAssets.retiredAt),
  ));
  if (assets.length !== new Set(ids).size) {
    throw new AppError("BRAND_ASSET_INVALID", "One or more brand images are unavailable.", 422);
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const expected: Array<[string | null, "LOGO" | "ICON" | "FAVICON"]> = [
    [draft.logoAssetId, "LOGO"], [draft.iconAssetId, "ICON"], [draft.faviconAssetId, "FAVICON"],
  ];
  for (const [id, kind] of expected) {
    if (id && byId.get(id) !== kind) {
      throw new AppError("BRAND_ASSET_INVALID", "A brand image was uploaded for a different use.", 422);
    }
  }
}

export async function saveBrandDraft(
  purchaserUserId: string,
  expectedRevision: number,
  input: BrandDraft,
) {
  await requireEffectiveWhitelabelPurchaser(purchaserUserId);
  const draft = brandDraftSchema.parse(input);
  await db.transaction(async (tx) => {
    const brand = await ensureBrand(tx, purchaserUserId);
    await assertAssetsBelongToBrand(tx, brand.id, draft);
    const [updated] = await tx.update(whitelabelBrands).set({
      draft,
      revision: expectedRevision + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(whitelabelBrands.id, brand.id),
      eq(whitelabelBrands.revision, expectedRevision),
    )).returning({ id: whitelabelBrands.id });
    if (!updated) {
      throw new AppError(
        "BRAND_REVISION_CONFLICT",
        "This brand was changed elsewhere. Reload the latest version before saving.",
        409,
      );
    }
  });
  return loadState(purchaserUserId);
}

export async function publishBrand(purchaserUserId: string, expectedRevision: number) {
  await requireEffectiveWhitelabelPurchaser(purchaserUserId);
  await db.transaction(async (tx) => {
    const brand = await ensureBrand(tx, purchaserUserId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whitelabel-brand:${brand.id}`}))`);
    const [locked] = await tx.select().from(whitelabelBrands)
      .where(eq(whitelabelBrands.id, brand.id)).limit(1);
    if (!locked || locked.revision !== expectedRevision) {
      throw new AppError(
        "BRAND_REVISION_CONFLICT",
        "This brand was changed elsewhere. Reload the latest version before publishing.",
        409,
      );
    }
    const parsed = brandPublishSchema.safeParse(locked.draft);
    if (!parsed.success) {
      throw new AppError("BRAND_NOT_READY", "Complete the required brand settings before publishing.", 422,
        parsed.error.flatten());
    }
    await assertAssetsBelongToBrand(tx, locked.id, parsed.data);
    const nextVersion = (locked.publishedVersion ?? 0) + 1;
    await tx.insert(whitelabelBrandVersions).values({
      brandId: locked.id,
      version: nextVersion,
      snapshot: parsed.data,
      publishedByUserId: purchaserUserId,
    });
    await tx.update(whitelabelBrands).set({
      publishedVersion: nextVersion,
      updatedAt: new Date(),
    }).where(eq(whitelabelBrands.id, locked.id));
  });
  return loadState(purchaserUserId);
}

export async function revertPublishedBrand(purchaserUserId: string, version: number) {
  await requireEffectiveWhitelabelPurchaser(purchaserUserId);
  await db.transaction(async (tx) => {
    const brand = await ensureBrand(tx, purchaserUserId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whitelabel-brand:${brand.id}`}))`);
    const [locked] = await tx.select().from(whitelabelBrands)
      .where(eq(whitelabelBrands.id, brand.id)).limit(1);
    const [source] = await tx.select({ snapshot: whitelabelBrandVersions.snapshot })
      .from(whitelabelBrandVersions).where(and(
        eq(whitelabelBrandVersions.brandId, brand.id),
        eq(whitelabelBrandVersions.version, version),
      )).limit(1);
    if (!locked || !source) {
      throw new AppError("BRAND_VERSION_NOT_FOUND", "That published brand version does not exist.", 404);
    }
    const snapshot = parsePublished(source.snapshot);
    await assertAssetsBelongToBrand(tx, locked.id, snapshot);
    const nextVersion = (locked.publishedVersion ?? 0) + 1;
    await tx.insert(whitelabelBrandVersions).values({
      brandId: locked.id,
      version: nextVersion,
      snapshot,
      publishedByUserId: purchaserUserId,
    });
    await tx.update(whitelabelBrands).set({
      draft: snapshot,
      revision: locked.revision + 1,
      publishedVersion: nextVersion,
      updatedAt: new Date(),
    }).where(eq(whitelabelBrands.id, locked.id));
  });
  return loadState(purchaserUserId);
}

export async function getPublishedBrandForPurchaser(purchaserUserId: string) {
  await requireEffectiveWhitelabelPurchaser(purchaserUserId);
  const state = await loadState(purchaserUserId);
  return state.published;
}

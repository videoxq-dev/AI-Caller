import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelBrandAssets, whitelabelBrands } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { ensureBrandForPurchaser } from "./brand-service";
import type { BrandAssetKind } from "./brand-schema";
import { getBrandAssetObject, optimizeAndStoreBrandAsset } from "./brand-assets";

export async function createBrandAsset(
  purchaserUserId: string,
  kind: BrandAssetKind,
  bytes: Uint8Array,
) {
  const brand = await ensureBrandForPurchaser(purchaserUserId);
  const id = randomUUID();
  const optimized = await optimizeAndStoreBrandAsset({
    brandId: brand.id,
    assetId: id,
    kind,
    bytes,
  });
  const [asset] = await db.insert(whitelabelBrandAssets).values({
    id,
    brandId: brand.id,
    kind,
    objectKey: optimized.objectKey,
    contentType: optimized.contentType,
    width: optimized.width,
    height: optimized.height,
    byteSize: optimized.byteSize,
    createdByUserId: purchaserUserId,
  }).returning({
    id: whitelabelBrandAssets.id,
    kind: whitelabelBrandAssets.kind,
    contentType: whitelabelBrandAssets.contentType,
    width: whitelabelBrandAssets.width,
    height: whitelabelBrandAssets.height,
    byteSize: whitelabelBrandAssets.byteSize,
  });
  return asset;
}

export async function getBrandAssetForPurchaser(purchaserUserId: string, assetId: string) {
  const [asset] = await db.select({
    objectKey: whitelabelBrandAssets.objectKey,
    contentType: whitelabelBrandAssets.contentType,
  }).from(whitelabelBrandAssets)
    .innerJoin(whitelabelBrands, eq(whitelabelBrands.id, whitelabelBrandAssets.brandId))
    .where(and(
      eq(whitelabelBrandAssets.id, assetId),
      eq(whitelabelBrands.purchaserUserId, purchaserUserId),
      isNull(whitelabelBrandAssets.retiredAt),
    )).limit(1);
  if (!asset) throw new AppError("BRAND_ASSET_NOT_FOUND", "Brand image not found.", 404);
  const stored = await getBrandAssetObject(asset.objectKey);
  return { ...stored, contentType: asset.contentType || stored.contentType };
}

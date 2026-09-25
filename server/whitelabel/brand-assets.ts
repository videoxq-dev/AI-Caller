import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp, { type OutputInfo } from "sharp";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import type { BrandAssetKind } from "./brand-schema";

export type OptimizedBrandAsset = {
  objectKey: string;
  contentType: "image/webp" | "image/png";
  width: number;
  height: number;
  byteSize: number;
};

const limits: Record<BrandAssetKind, number> = {
  LOGO: 5 * 1024 * 1024,
  ICON: 3 * 1024 * 1024,
  FAVICON: 2 * 1024 * 1024,
};

let s3Client: S3Client | null = null;

function s3() {
  const env = getEnv();
  if (!env.BRAND_ASSET_S3_BUCKET) throw new Error("BRAND_ASSET_S3_BUCKET is required for S3 brand assets.");
  if (!s3Client) {
    const credentials = env.BRAND_ASSET_S3_ACCESS_KEY_ID && env.BRAND_ASSET_S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.BRAND_ASSET_S3_ACCESS_KEY_ID,
          secretAccessKey: env.BRAND_ASSET_S3_SECRET_ACCESS_KEY,
        }
      : undefined;
    s3Client = new S3Client({
      region: env.BRAND_ASSET_S3_REGION,
      endpoint: env.BRAND_ASSET_S3_ENDPOINT,
      forcePathStyle: Boolean(env.BRAND_ASSET_S3_ENDPOINT),
      credentials,
    });
  }
  return { client: s3Client, bucket: env.BRAND_ASSET_S3_BUCKET };
}

function assertGeneratedKey(key: string) {
  if (!/^whitelabel\/[0-9a-f-]{36}\/(logo|icon|favicon)\/[0-9a-f-]{36}\.(webp|png)$/.test(key)) {
    throw new Error("Invalid brand asset object key.");
  }
  return key;
}

function filesystemPath(root: string, key: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, assertGeneratedKey(key));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid brand asset path.");
  return resolved;
}

async function putObject(key: string, bytes: Uint8Array, contentType: string) {
  const env = getEnv();
  if (env.BRAND_ASSET_STORAGE_BACKEND === "s3") {
    const { client, bucket } = s3();
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: assertGeneratedKey(key), Body: bytes,
      ContentType: contentType, CacheControl: "public,max-age=31536000,immutable",
    }));
    return;
  }
  if (env.NODE_ENV === "production"
    && (!env.BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM || !path.isAbsolute(env.BRAND_ASSET_DIR))) {
    throw new Error(
      "Production filesystem brand assets require BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM=true and an absolute BRAND_ASSET_DIR backed by a persistent volume, or configure S3.",
    );
  }
  const target = filesystemPath(env.BRAND_ASSET_DIR, key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o644 });
}

export async function getBrandAssetObject(key: string) {
  const env = getEnv();
  if (env.BRAND_ASSET_STORAGE_BACKEND === "s3") {
    const { client, bucket } = s3();
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: assertGeneratedKey(key) }));
    if (!result.Body) throw new Error("Brand asset object has no body.");
    const bytes = await result.Body.transformToByteArray();
    return {
      bytes,
      contentType: result.ContentType ?? (key.endsWith(".png") ? "image/png" : "image/webp"),
    };
  }
  return {
    bytes: new Uint8Array(await readFile(filesystemPath(env.BRAND_ASSET_DIR, key))),
    contentType: key.endsWith(".png") ? "image/png" : "image/webp",
  };
}

export async function optimizeAndStoreBrandAsset(input: {
  brandId: string;
  assetId: string;
  kind: BrandAssetKind;
  bytes: Uint8Array;
}): Promise<OptimizedBrandAsset> {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > limits[input.kind]) {
    throw new AppError(
      "BRAND_ASSET_SIZE_INVALID",
      `${input.kind === "LOGO" ? "Logo" : input.kind === "ICON" ? "App icon" : "Favicon"} must be smaller than ${Math.round(limits[input.kind] / 1024 / 1024)} MB.`,
      422,
    );
  }

  let image = sharp(input.bytes, { animated: false, limitInputPixels: 40_000_000 }).rotate();
  const metadata = await image.metadata().catch(() => null);
  if (!metadata || !metadata.width || !metadata.height
    || !metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)) {
    throw new AppError("BRAND_ASSET_FORMAT_INVALID", "Upload a PNG, JPEG or WebP image.", 422);
  }

  let extension: "webp" | "png";
  let contentType: "image/webp" | "image/png";
  let result: { data: Buffer; info: OutputInfo };

  if (input.kind === "LOGO") {
    extension = "webp";
    contentType = "image/webp";
    result = await image
      .resize({ width: 1600, height: 600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer({ resolveWithObject: true });
  } else if (input.kind === "ICON") {
    extension = "webp";
    contentType = "image/webp";
    result = await image
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 86 })
      .toBuffer({ resolveWithObject: true });
  } else {
    extension = "png";
    contentType = "image/png";
    result = await image
      .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
  }

  const key = assertGeneratedKey(
    `whitelabel/${input.brandId}/${input.kind.toLowerCase()}/${input.assetId}.${extension}`,
  );
  await putObject(key, new Uint8Array(result.data), contentType);
  return {
    objectKey: key,
    contentType,
    width: result.info.width,
    height: result.info.height,
    byteSize: result.info.size,
  };
}

export function resetBrandAssetStorageForTests() {
  s3Client = null;
}

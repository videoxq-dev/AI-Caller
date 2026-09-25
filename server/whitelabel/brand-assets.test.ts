import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  current: {
    NODE_ENV: "production" as const,
    BRAND_ASSET_STORAGE_BACKEND: "filesystem" as const,
    BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM: true,
    BRAND_ASSET_DIR: "",
    BRAND_ASSET_S3_BUCKET: undefined as string | undefined,
    BRAND_ASSET_S3_REGION: "us-east-1",
    BRAND_ASSET_S3_ENDPOINT: undefined as string | undefined,
    BRAND_ASSET_S3_ACCESS_KEY_ID: undefined as string | undefined,
    BRAND_ASSET_S3_SECRET_ACCESS_KEY: undefined as string | undefined,
  },
}));
vi.mock("@/server/env", () => ({ getEnv: () => env.current }));

import { getBrandAssetObject, optimizeAndStoreBrandAsset } from "./brand-assets";

describe("F12-C brand image optimization and filesystem storage", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    env.current.BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM = true;
  });

  async function root() {
    const dir = await mkdtemp(path.join(tmpdir(), "brand-assets-"));
    dirs.push(dir);
    env.current.BRAND_ASSET_DIR = dir;
    return dir;
  }

  it("downsizes a large logo while preserving its aspect ratio", async () => {
    await root();
    const input = await sharp({
      create: { width: 3000, height: 1000, channels: 4, background: "#334455" },
    }).png().toBuffer();
    const asset = await optimizeAndStoreBrandAsset({
      brandId: "11111111-1111-4111-8111-111111111111",
      assetId: "22222222-2222-4222-8222-222222222222",
      kind: "LOGO", bytes: new Uint8Array(input),
    });
    expect(asset).toMatchObject({ contentType: "image/webp", width: 1600 });
    expect(asset.height).toBeLessThanOrEqual(600);
    const stored = await getBrandAssetObject(asset.objectKey);
    expect(stored.bytes.byteLength).toBe(asset.byteSize);
  });

  it("normalizes icon and favicon assets to predictable square dimensions", async () => {
    await root();
    const input = new Uint8Array(await sharp({
      create: { width: 800, height: 400, channels: 4, background: "#ffffff" },
    }).jpeg().toBuffer());
    const icon = await optimizeAndStoreBrandAsset({
      brandId: "11111111-1111-4111-8111-111111111111",
      assetId: "33333333-3333-4333-8333-333333333333",
      kind: "ICON", bytes: input,
    });
    const favicon = await optimizeAndStoreBrandAsset({
      brandId: "11111111-1111-4111-8111-111111111111",
      assetId: "44444444-4444-4444-8444-444444444444",
      kind: "FAVICON", bytes: input,
    });
    expect(icon).toMatchObject({ width: 512, height: 512, contentType: "image/webp" });
    expect(favicon).toMatchObject({ width: 128, height: 128, contentType: "image/png" });
  });

  it("rejects unsupported or corrupt input without a separate scanning pipeline", async () => {
    await root();
    await expect(optimizeAndStoreBrandAsset({
      brandId: "11111111-1111-4111-8111-111111111111",
      assetId: "55555555-5555-4555-8555-555555555555",
      kind: "LOGO", bytes: new Uint8Array([1, 2, 3, 4]),
    })).rejects.toMatchObject({ code: "BRAND_ASSET_FORMAT_INVALID", status: 422 });
  });

  it("requires an explicit persistent mount when filesystem storage runs in production mode", async () => {
    await root();
    env.current.BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM = false;
    const input = new Uint8Array(await sharp({
      create: { width: 50, height: 50, channels: 4, background: "#ffffff" },
    }).png().toBuffer());
    await expect(optimizeAndStoreBrandAsset({
      brandId: "11111111-1111-4111-8111-111111111111",
      assetId: "66666666-6666-4666-8666-666666666666",
      kind: "LOGO", bytes: input,
    })).rejects.toThrow("BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM=true");
  });
});

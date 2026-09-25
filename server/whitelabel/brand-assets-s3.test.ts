import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aws = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = aws.send;
  },
  PutObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) { this.input = input; }
  },
  GetObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) { this.input = input; }
  },
}));

const env = vi.hoisted(() => ({
  current: {
    NODE_ENV: "production" as const,
    BRAND_ASSET_STORAGE_BACKEND: "s3" as "filesystem" | "s3",
    BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM: false,
    BRAND_ASSET_DIR: "/unused",
    BRAND_ASSET_S3_BUCKET: "brand-assets",
    BRAND_ASSET_S3_REGION: "us-east-1",
    BRAND_ASSET_S3_ENDPOINT: "https://s3.example.test",
    BRAND_ASSET_S3_ACCESS_KEY_ID: "access-key" as string | undefined,
    BRAND_ASSET_S3_SECRET_ACCESS_KEY: "secret-key" as string | undefined,
  },
}));
vi.mock("@/server/env", () => ({ getEnv: () => env.current }));

import {
  getBrandAssetObject,
  optimizeAndStoreBrandAsset,
  resetBrandAssetStorageForTests,
} from "./brand-assets";

describe("F12-C S3-compatible brand asset storage", () => {
  beforeEach(() => {
    aws.send.mockReset();
    resetBrandAssetStorageForTests();
    env.current.BRAND_ASSET_STORAGE_BACKEND = "s3";
    env.current.BRAND_ASSET_S3_BUCKET = "brand-assets";
    env.current.BRAND_ASSET_S3_ACCESS_KEY_ID = "access-key";
    env.current.BRAND_ASSET_S3_SECRET_ACCESS_KEY = "secret-key";
  });

  it("stores optimized output in the configured S3-compatible bucket with immutable caching", async () => {
    aws.send.mockResolvedValueOnce({});
    const input = new Uint8Array(await sharp({
      create: { width: 300, height: 100, channels: 4, background: "#335577" },
    }).png().toBuffer());

    const asset = await optimizeAndStoreBrandAsset({
      brandId: "11111111-1111-4111-8111-111111111111",
      assetId: "22222222-2222-4222-8222-222222222222",
      kind: "LOGO",
      bytes: input,
    });

    expect(asset.objectKey).toBe(
      "whitelabel/11111111-1111-4111-8111-111111111111/logo/22222222-2222-4222-8222-222222222222.webp",
    );
    expect(aws.send).toHaveBeenCalledTimes(1);
    expect(aws.send.mock.calls[0][0].input).toMatchObject({
      Bucket: "brand-assets",
      Key: asset.objectKey,
      ContentType: "image/webp",
      CacheControl: "public,max-age=31536000,immutable",
    });
  });

  it("reads an S3-compatible object without exposing storage credentials", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    aws.send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => bytes },
      ContentType: "image/webp",
    });
    const stored = await getBrandAssetObject(
      "whitelabel/11111111-1111-4111-8111-111111111111/logo/22222222-2222-4222-8222-222222222222.webp",
    );
    expect(stored).toEqual({ bytes, contentType: "image/webp" });
    expect(aws.send.mock.calls[0][0].input).toMatchObject({
      Bucket: "brand-assets",
    });
  });

  it("rejects a partial explicit S3 credential pair", async () => {
    env.current.BRAND_ASSET_S3_SECRET_ACCESS_KEY = undefined;
    const input = new Uint8Array(await sharp({
      create: { width: 20, height: 20, channels: 4, background: "#ffffff" },
    }).png().toBuffer());
    await expect(optimizeAndStoreBrandAsset({
      brandId: "11111111-1111-4111-8111-111111111111",
      assetId: "33333333-3333-4333-8333-333333333333",
      kind: "LOGO",
      bytes: input,
    })).rejects.toThrow("Set both BRAND_ASSET_S3_ACCESS_KEY_ID");
    expect(aws.send).not.toHaveBeenCalled();
  });
});

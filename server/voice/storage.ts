import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "@/server/env";

export type RecordingRange = { start: number; end?: number };
export type RecordingObject = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number | null;
  contentRange: string | null;
  status: 200 | 206;
};

function assertObjectKey(key: string) {
  if (!/^[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(key) || key.includes("..")) {
    throw new Error("Invalid voice recording object key.");
  }
  return key;
}

function filesystemPath(root: string, key: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, assertObjectKey(key));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid voice recording path.");
  return resolved;
}

function parseContentRange(range: RecordingRange, total: number) {
  const start = Math.max(0, Math.min(range.start, Math.max(total - 1, 0)));
  const end = Math.max(start, Math.min(range.end ?? total - 1, total - 1));
  return { start, end };
}

let s3Client: S3Client | null = null;

function s3() {
  const env = getEnv();
  if (!env.VOICE_RECORDING_S3_BUCKET) throw new Error("VOICE_RECORDING_S3_BUCKET is required for S3 recording storage.");
  if (!s3Client) {
    const credentials = env.VOICE_RECORDING_S3_ACCESS_KEY_ID && env.VOICE_RECORDING_S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.VOICE_RECORDING_S3_ACCESS_KEY_ID,
          secretAccessKey: env.VOICE_RECORDING_S3_SECRET_ACCESS_KEY,
        }
      : undefined;
    s3Client = new S3Client({
      region: env.VOICE_RECORDING_S3_REGION,
      endpoint: env.VOICE_RECORDING_S3_ENDPOINT,
      forcePathStyle: Boolean(env.VOICE_RECORDING_S3_ENDPOINT),
      credentials,
    });
  }
  return { client: s3Client, bucket: env.VOICE_RECORDING_S3_BUCKET };
}

export async function putVoiceRecording(key: string, bytes: Uint8Array, contentType: string) {
  assertObjectKey(key);
  const env = getEnv();
  if (env.VOICE_RECORDING_STORAGE_BACKEND === "s3") {
    const { client, bucket } = s3();
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    }));
    return;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("Filesystem voice recording storage is not allowed in production.");
  }
  const target = filesystemPath(env.VOICE_RECORDING_DIR, key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o600 });
}

export async function getVoiceRecording(key: string, range?: RecordingRange): Promise<RecordingObject> {
  assertObjectKey(key);
  const env = getEnv();
  if (env.VOICE_RECORDING_STORAGE_BACKEND === "s3") {
    const { client, bucket } = s3();
    const requestedRange = range ? `bytes=${range.start}-${range.end ?? ""}` : undefined;
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: requestedRange,
    }));
    if (!response.Body) throw new Error("Voice recording object has no body.");
    const body = response.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    return {
      body,
      contentType: response.ContentType ?? "audio/mpeg",
      contentLength: response.ContentLength ?? null,
      contentRange: response.ContentRange ?? null,
      status: response.ContentRange ? 206 : 200,
    };
  }

  const target = filesystemPath(env.VOICE_RECORDING_DIR, key);
  const info = await stat(target);
  if (!range) {
    const stream = createReadStream(target);
    return {
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      contentType: target.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
      contentLength: info.size,
      contentRange: null,
      status: 200,
    };
  }
  const parsed = parseContentRange(range, info.size);
  const stream = createReadStream(target, { start: parsed.start, end: parsed.end });
  return {
    body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
    contentType: target.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
    contentLength: parsed.end - parsed.start + 1,
    contentRange: `bytes ${parsed.start}-${parsed.end}/${info.size}`,
    status: 206,
  };
}

export function resetVoiceRecordingStorageForTests() {
  s3Client = null;
}

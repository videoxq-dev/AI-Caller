import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  current: {
    NODE_ENV: "production" as const,
    VOICE_RECORDING_STORAGE_BACKEND: "filesystem" as const,
    VOICE_RECORDING_DIR: "",
    VOICE_RECORDING_ALLOW_PERSISTENT_FILESYSTEM: false,
  },
}));
vi.mock("@/server/env", () => ({ getEnv: () => env.current }));
vi.mock("@/server/providers/e2e-fixtures", () => ({ isE2EProviderFixtureMode: () => false }));

import { putVoiceRecording } from "./storage";

describe("production voice filesystem archival", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
    env.current.VOICE_RECORDING_ALLOW_PERSISTENT_FILESYSTEM = false;
    env.current.VOICE_RECORDING_DIR = "";
  });

  it("refuses unsafe default even if it resolves to an ordinary local path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-storage-denied-"));
    directories.push(dir);
    env.current.VOICE_RECORDING_DIR = dir;
    await expect(putVoiceRecording("workspaces/ws/voice/call/recording.mp3", new Uint8Array([1]), "audio/mpeg"))
      .rejects.toThrow("VOICE_RECORDING_ALLOW_PERSISTENT_FILESYSTEM=true");
  });

  it("archives a recording with explicit approval and absolute mounted directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-storage-approved-"));
    directories.push(dir);
    env.current.VOICE_RECORDING_DIR = dir;
    env.current.VOICE_RECORDING_ALLOW_PERSISTENT_FILESYSTEM = true;
    const key = "workspaces/ws/voice/call/recording.mp3";
    await putVoiceRecording(key, new Uint8Array([1, 2, 3]), "audio/mpeg");
    expect(await readFile(path.join(dir, key))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects a relative path even with explicit approval", async () => {
    env.current.VOICE_RECORDING_DIR = ".data/recordings";
    env.current.VOICE_RECORDING_ALLOW_PERSISTENT_FILESYSTEM = true;
    await expect(putVoiceRecording("workspaces/ws/voice/call/recording.mp3", new Uint8Array([1]), "audio/mpeg"))
      .rejects.toThrow("absolute VOICE_RECORDING_DIR");
  });
});

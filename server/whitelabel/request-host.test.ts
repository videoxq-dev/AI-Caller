import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { isCanonicalAiCallerHost, normalizeIncomingHost } from "./request-host";

describe("F12-D6 incoming host classification", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("normalizes case, ports, trailing dots and IPv6 loopback", () => {
    expect(normalizeIncomingHost("App.AICaller.com:443")).toBe("app.aicaller.com");
    expect(normalizeIncomingHost("app.aicaller.com.")).toBe("app.aicaller.com");
    expect(normalizeIncomingHost("[::1]:3000")).toBe("::1");
  });

  it("rejects malformed Host header values", () => {
    expect(normalizeIncomingHost("")).toBeNull();
    expect(normalizeIncomingHost("app.aicaller.com/path")).toBeNull();
    expect(normalizeIncomingHost("user@app.aicaller.com")).toBeNull();
    expect(normalizeIncomingHost("app.aicaller.com bad")).toBeNull();
  });

  it("accepts the configured canonical app host and loopback development origins", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.aicaller.com");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "console.aicaller.com");
    resetEnvForTests();
    expect(isCanonicalAiCallerHost("app.aicaller.com")).toBe(true);
    expect(isCanonicalAiCallerHost("console.aicaller.com:443")).toBe(true);
    expect(isCanonicalAiCallerHost("127.0.0.1:3000")).toBe(true);
    expect(isCanonicalAiCallerHost("[::1]:3000")).toBe(true);
  });

  it("does not treat purchaser-controlled custom domains as canonical", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.aicaller.com");
    resetEnvForTests();
    expect(isCanonicalAiCallerHost("clients.stratosassist.com")).toBe(false);
    expect(isCanonicalAiCallerHost("unknown.example.com")).toBe(false);
  });
});

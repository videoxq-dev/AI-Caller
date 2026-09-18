import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { buildVoiceGatewayStreamUrl, verifyVoiceGatewayRequest } from "./gateway-auth";

describe("voice gateway authentication", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;
  const originalUrl = process.env.VOICE_GATEWAY_URL;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "voice-gateway-test-secret-12345678901234567890";
    process.env.VOICE_GATEWAY_URL = "ws://127.0.0.1:3002";
    resetEnvForTests();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
    if (originalUrl === undefined) delete process.env.VOICE_GATEWAY_URL;
    else process.env.VOICE_GATEWAY_URL = originalUrl;
    resetEnvForTests();
  });

  it("accepts a fresh signed stream URL and rejects tampering", () => {
    const now = Date.now();
    const signed = buildVoiceGatewayStreamUrl("workspace-1", "call-1", "external-1", now);
    expect(signed).toBeTruthy();
    const url = new URL(signed!);
    expect(verifyVoiceGatewayRequest(url, now)).toEqual(expect.objectContaining({
      workspaceId: "workspace-1",
      callId: "call-1",
      externalCallId: "external-1",
    }));

    url.searchParams.set("callId", "call-2");
    expect(verifyVoiceGatewayRequest(url, now)).toBeNull();
  });

  it("rejects expired stream URLs", () => {
    const issuedAt = Date.now();
    const signed = buildVoiceGatewayStreamUrl("workspace-1", "call-1", "external-1", issuedAt);
    expect(verifyVoiceGatewayRequest(new URL(signed!), issuedAt + 12 * 60 * 1000)).toBeNull();
  });
});

import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/server/env";
import { isE2EProviderFixtureMode } from "@/server/providers/e2e-fixtures";

function signature(workspaceId: string, callId: string, externalCallId: string, expiresAt: number) {
  const secret = getEnv().BETTER_AUTH_SECRET;
  return createHmac("sha256", secret)
    .update(`${workspaceId}.${callId}.${externalCallId}.${expiresAt}`)
    .digest("base64url");
}

export function buildVoiceGatewayStreamUrl(
  workspaceId: string,
  callId: string,
  externalCallId: string,
  now = Date.now(),
) {
  const base = getEnv().VOICE_GATEWAY_URL;
  if (!base) return null;
  const url = new URL(base);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("VOICE_GATEWAY_URL must use ws:// or wss://.");
  }
  if (getEnv().NODE_ENV === "production" && url.protocol !== "wss:" && !isE2EProviderFixtureMode()) {
    throw new Error("Production voice gateway URLs must use wss://.");
  }
  const expiresAt = Math.floor(now / 1000) + 10 * 60;
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("callId", callId);
  url.searchParams.set("externalCallId", externalCallId);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("token", signature(workspaceId, callId, externalCallId, expiresAt));
  return url.toString();
}

export function verifyVoiceGatewayRequest(url: URL, now = Date.now()) {
  const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
  const callId = url.searchParams.get("callId")?.trim() ?? "";
  const externalCallId = url.searchParams.get("externalCallId")?.trim() ?? "";
  const expiresAt = Number(url.searchParams.get("expires"));
  const token = url.searchParams.get("token") ?? "";
  if (!workspaceId || !callId || !externalCallId || !Number.isInteger(expiresAt) || !token) return null;
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt < nowSeconds || expiresAt > nowSeconds + 11 * 60) return null;

  const expected = signature(workspaceId, callId, externalCallId, expiresAt);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return { workspaceId, callId, externalCallId, expiresAt };
}

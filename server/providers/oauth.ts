import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/server/env";
import { providerJson } from "./http";

export type OAuthProviderId = "google" | "outlook";

type OAuthStatePayload = {
  provider: OAuthProviderId;
  workspaceId: string;
  returnTo: string;
  expiresAt: number;
};

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(payload: string) {
  return createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update(payload).digest("base64url");
}

export function normalizeLocalReturnPath(value: string | null | undefined, fallback = "/integrations") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const base = new URL("https://aicaller.local");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function createOAuthState(input: { provider: OAuthProviderId; workspaceId: string; returnTo?: string | null }) {
  const payload: OAuthStatePayload = {
    provider: input.provider,
    workspaceId: input.workspaceId,
    returnTo: normalizeLocalReturnPath(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded)}`;
}

export function verifyOAuthState(value: string) {
  const [encoded, received] = value.split(".");
  if (!encoded || !received) throw new Error("Invalid OAuth state.");
  const expected = signature(encoded);
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Invalid OAuth state signature.");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  if (!payload.workspaceId || !["google", "outlook"].includes(payload.provider)) throw new Error("Invalid OAuth state payload.");
  if (payload.expiresAt < Date.now()) throw new Error("OAuth state expired. Please connect again.");
  return { ...payload, returnTo: normalizeLocalReturnPath(payload.returnTo) };
}

function callbackUrl(provider: OAuthProviderId) {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/api/integrations/oauth/${provider}/callback`;
}

export function getOAuthAuthorizationUrl(provider: OAuthProviderId, state: string) {
  const env = getEnv();
  if (provider === "google") {
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error("Google OAuth is not configured on the server.");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: callbackUrl("google"),
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope: "openid email profile https://www.googleapis.com/auth/calendar",
      state,
    }).toString();
    return url.toString();
  }

  if (!env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) throw new Error("Microsoft OAuth is not configured on the server.");
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.search = new URLSearchParams({
    client_id: env.MICROSOFT_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl("outlook"),
    response_type: "code",
    response_mode: "query",
    scope: "offline_access User.Read Calendars.ReadWrite",
    state,
  }).toString();
  return url.toString();
}

export async function exchangeOAuthCode(provider: OAuthProviderId, code: string, fetcher: typeof fetch = fetch) {
  const env = getEnv();
  if (provider === "google") {
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error("Google OAuth is not configured on the server.");
    const body = new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, code, redirect_uri: callbackUrl("google"), grant_type: "authorization_code" });
    const token = await providerJson<{ access_token: string; refresh_token?: string; expires_in?: number }>("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, fetcher);
    if (!token.refresh_token) throw new Error("Google did not return an offline refresh token. Reconnect and grant offline access.");
    const calendars = await providerJson<{ items?: Array<{ id?: string; summary?: string; primary?: boolean }> }>("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=20", { headers: { authorization: `Bearer ${token.access_token}` } }, fetcher);
    const primary = calendars.items?.find((item) => item.primary) ?? calendars.items?.[0];
    return { credentials: { refreshToken: token.refresh_token }, settings: { calendar: primary?.id ?? "primary", connectionMetadata: { calendarName: primary?.summary ?? "Primary calendar" }, authMethod: "OAUTH" } };
  }

  if (!env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) throw new Error("Microsoft OAuth is not configured on the server.");
  const body = new URLSearchParams({ client_id: env.MICROSOFT_OAUTH_CLIENT_ID, client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET, code, redirect_uri: callbackUrl("outlook"), grant_type: "authorization_code", scope: "offline_access User.Read Calendars.ReadWrite" });
  const token = await providerJson<{ access_token: string; refresh_token?: string }>("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, fetcher);
  if (!token.refresh_token) throw new Error("Microsoft did not return an offline refresh token. Please reconnect.");
  const primary = await providerJson<{ id?: string; name?: string }>("https://graph.microsoft.com/v1.0/me/calendar", { headers: { authorization: `Bearer ${token.access_token}` } }, fetcher);
  return { credentials: { refreshToken: token.refresh_token }, settings: { calendar: primary.id ?? "Calendar", connectionMetadata: { calendarName: primary.name ?? "Calendar" }, authMethod: "OAUTH" } };
}

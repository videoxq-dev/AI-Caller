import { getEnv } from "@/server/env";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import type { PrivateIntegration } from "../connections";
import { providerJson } from "../http";

export type Credentials = Record<string, string>;
export type RuntimeSettings = Record<string, unknown>;
export type BusyRange = { startsAt: Date; endsAt: Date };
export type CalendarInput = PrivateIntegration & { runtimeSettings?: RuntimeSettings };

export function decryptCredentials(input: PrivateIntegration) {
  if (!input.encryptedCredentials) throw new Error(`No saved credentials are available for ${input.provider}.`);
  return decryptIntegrationCredentials<Credentials>(input.encryptedCredentials as EncryptedSecretEnvelope);
}

export function requireCredential(values: Credentials, key: string, label: string) {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

export function stringSetting(settings: RuntimeSettings, ...keys: string[]) {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const metadata = settings.connectionMetadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const values = metadata as Record<string, unknown>;
    for (const key of keys) {
      const value = values[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  return undefined;
}

export function numberSetting(settings: RuntimeSettings, key: string, fallback: number) {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseDate(value: string | undefined, fallback: Date) {
  if (!value) return fallback;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function toUtcLocalString(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

export function slotize(startsAt: Date, endsAt: Date, busy: BusyRange[], durationMinutes: number) {
  const durationMs = durationMinutes * 60_000;
  const sorted = busy
    .filter((item) => item.endsAt > startsAt && item.startsAt < endsAt)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const slots: Array<{ startsAt: Date; endsAt: Date }> = [];

  for (let cursor = startsAt.getTime(); cursor + durationMs <= endsAt.getTime(); cursor += durationMs) {
    const candidateStart = new Date(cursor);
    const candidateEnd = new Date(cursor + durationMs);
    const overlaps = sorted.some((item) => candidateStart < item.endsAt && candidateEnd > item.startsAt);
    if (!overlaps) slots.push({ startsAt: candidateStart, endsAt: candidateEnd });
  }

  return slots;
}

export async function googleAccessToken(refreshToken: string, fetcher: typeof fetch) {
  const env = getEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error("Google OAuth is not configured on the server.");
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const token = await providerJson<{ access_token?: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, fetcher);
  if (!token.access_token) throw new Error("Google did not return an access token.");
  return token.access_token;
}

export async function microsoftAccessToken(refreshToken: string, fetcher: typeof fetch) {
  const env = getEnv();
  if (!env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) throw new Error("Microsoft OAuth is not configured on the server.");
  const body = new URLSearchParams({
    client_id: env.MICROSOFT_OAUTH_CLIENT_ID,
    client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: "offline_access User.Read Calendars.ReadWrite",
  });
  const token = await providerJson<{ access_token?: string }>("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, fetcher);
  if (!token.access_token) throw new Error("Microsoft did not return an access token.");
  return token.access_token;
}

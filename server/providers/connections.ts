import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import { getEnv } from "@/server/env";
import { basicAuth, providerJson } from "./http";
import type { ProviderConnectionResult } from "./contracts";

export type PrivateIntegration = {
  provider: string;
  encryptedCredentials: Record<string, unknown> | null;
  settings: Record<string, unknown>;
};

type Credentials = Record<string, string>;

function credentials(input: PrivateIntegration): Credentials {
  if (!input.encryptedCredentials) throw new Error("No saved credentials are available for this integration.");
  return decryptIntegrationCredentials<Credentials>(input.encryptedCredentials as EncryptedSecretEnvelope);
}

function requireValue(values: Credentials, key: string, label: string) {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

async function refreshGoogleToken(refreshToken: string, fetcher: typeof fetch) {
  const env = getEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error("Google OAuth is not configured on the server.");
  const body = new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" });
  return providerJson<{ access_token: string }>("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, fetcher);
}

async function refreshMicrosoftToken(refreshToken: string, fetcher: typeof fetch) {
  const env = getEnv();
  if (!env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) throw new Error("Microsoft OAuth is not configured on the server.");
  const body = new URLSearchParams({ client_id: env.MICROSOFT_OAUTH_CLIENT_ID, client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token", scope: "offline_access User.Read Calendars.ReadWrite" });
  return providerJson<{ access_token: string }>("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, fetcher);
}

export async function testProviderConnection(input: PrivateIntegration, fetcher: typeof fetch = fetch): Promise<ProviderConnectionResult> {
  const values = credentials(input);

  switch (input.provider) {
    case "openai": {
      const apiKey = requireValue(values, "apiKey", "OpenAI API key");
      await providerJson("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${apiKey}` } }, fetcher);
      return { ok: true };
    }
    case "gemini": {
      const apiKey = requireValue(values, "apiKey", "Gemini API key");
      await providerJson("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": apiKey } }, fetcher);
      return { ok: true };
    }
    case "openrouter": {
      const apiKey = requireValue(values, "apiKey", "OpenRouter API key");
      await providerJson("https://openrouter.ai/api/v1/models", { headers: { authorization: `Bearer ${apiKey}` } }, fetcher);
      return { ok: true };
    }
    case "twilio": {
      const sid = requireValue(values, "sid", "Twilio Account SID");
      const token = requireValue(values, "authToken", "Twilio Auth Token");
      const account = await providerJson<{ friendly_name?: string; status?: string }>(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, { headers: { authorization: basicAuth(sid, token) } }, fetcher);
      return { ok: true, metadata: { accountName: account.friendly_name ?? null, accountStatus: account.status ?? null } };
    }
    case "telnyx": {
      const apiKey = requireValue(values, "apiKey", "Telnyx API key");
      await providerJson("https://api.telnyx.com/v2/messaging_profiles?page[size]=1", { headers: { authorization: `Bearer ${apiKey}` } }, fetcher);
      return { ok: true };
    }
    case "plivo": {
      const authId = requireValue(values, "authId", "Plivo Auth ID");
      const authToken = requireValue(values, "authToken", "Plivo Auth Token");
      const account = await providerJson<{ name?: string }>(`https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/`, { headers: { authorization: basicAuth(authId, authToken) } }, fetcher);
      return { ok: true, metadata: { accountName: account.name ?? null } };
    }
    case "calendly": {
      const token = requireValue(values, "token", "Calendly Personal Access Token");
      const me = await providerJson<{ resource?: { name?: string; email?: string; current_organization?: string } }>("https://api.calendly.com/users/me", { headers: { authorization: `Bearer ${token}` } }, fetcher);
      return { ok: true, metadata: { accountName: me.resource?.name ?? null, accountEmail: me.resource?.email ?? null, organizationUri: me.resource?.current_organization ?? null } };
    }
    case "calcom": {
      const apiKey = requireValue(values, "apiKey", "Cal.com API key");
      const me = await providerJson<{ data?: { name?: string; email?: string; username?: string } }>("https://api.cal.com/v2/me", { headers: { authorization: `Bearer ${apiKey}`, "cal-api-version": getEnv().CALCOM_API_VERSION } }, fetcher);
      return { ok: true, metadata: { accountName: me.data?.name ?? null, accountEmail: me.data?.email ?? null, username: me.data?.username ?? null } };
    }
    case "google": {
      const refreshToken = requireValue(values, "refreshToken", "Google OAuth refresh token");
      const token = await refreshGoogleToken(refreshToken, fetcher);
      const list = await providerJson<{ items?: Array<{ id?: string; summary?: string; primary?: boolean }> }>("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=20", { headers: { authorization: `Bearer ${token.access_token}` } }, fetcher);
      const primary = list.items?.find((item) => item.primary) ?? list.items?.[0];
      return { ok: true, metadata: { calendarId: primary?.id ?? null, calendarName: primary?.summary ?? null } };
    }
    case "outlook": {
      const refreshToken = requireValue(values, "refreshToken", "Microsoft OAuth refresh token");
      const token = await refreshMicrosoftToken(refreshToken, fetcher);
      const list = await providerJson<{ value?: Array<{ id?: string; name?: string }> }>("https://graph.microsoft.com/v1.0/me/calendars?$top=20", { headers: { authorization: `Bearer ${token.access_token}` } }, fetcher);
      const primary = list.value?.[0];
      return { ok: true, metadata: { calendarId: primary?.id ?? null, calendarName: primary?.name ?? null } };
    }
    case "whatsapp": {
      const token = requireValue(values, "accessToken", "Meta access token");
      const phoneNumberId = requireValue(values, "phoneNumberId", "WhatsApp Phone Number ID");
      const env = getEnv();
      const phone = await providerJson<{ display_phone_number?: string; verified_name?: string }>(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { authorization: `Bearer ${token}` } }, fetcher);
      return { ok: true, metadata: { displayPhoneNumber: phone.display_phone_number ?? null, verifiedName: phone.verified_name ?? null } };
    }
    default:
      throw new Error(`Connection testing is not implemented for provider ${input.provider}.`);
  }
}

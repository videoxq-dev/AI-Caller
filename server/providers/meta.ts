import { getEnv } from "@/server/env";
import { providerJson } from "./http";

export type MetaEmbeddedSignupInput = {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  businessId?: string | null;
};

export function getMetaPublicConfig() {
  const env = getEnv();
  return {
    enabled: Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_EMBEDDED_SIGNUP_CONFIG_ID),
    appId: env.META_APP_ID ?? null,
    configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? null,
    graphApiVersion: env.META_GRAPH_API_VERSION,
  };
}

export async function completeMetaEmbeddedSignup(input: MetaEmbeddedSignupInput, fetcher: typeof fetch = fetch) {
  const env = getEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_EMBEDDED_SIGNUP_CONFIG_ID) throw new Error("Meta Embedded Signup is not configured on the server.");
  if (!input.code || !input.wabaId || !input.phoneNumberId) throw new Error("Meta Embedded Signup did not return all required WhatsApp assets.");

  const tokenBody = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, code: input.code });
  const token = await providerJson<{ access_token: string }>(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenBody }, fetcher);
  if (!token.access_token) throw new Error("Meta did not return an access token.");

  const phone = await providerJson<{ display_phone_number?: string; verified_name?: string }>(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(input.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { authorization: `Bearer ${token.access_token}` } }, fetcher);
  const waba = await providerJson<{ id?: string; name?: string; currency?: string }>(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(input.wabaId)}?fields=id,name,currency`, { headers: { authorization: `Bearer ${token.access_token}` } }, fetcher);

  if (env.META_PHONE_REGISTRATION_PIN) {
    await providerJson(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(input.phoneNumberId)}/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: env.META_PHONE_REGISTRATION_PIN }),
    }, fetcher);
  }

  await providerJson(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(input.wabaId)}/subscribed_apps`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } }, fetcher);

  return {
    credentials: {
      accessToken: token.access_token,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      ...(input.businessId ? { businessId: input.businessId } : {}),
    },
    settings: {
      authMethod: "EMBEDDED_SIGNUP",
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      businessId: input.businessId ?? null,
      displayPhoneNumber: phone.display_phone_number ?? null,
      verifiedName: phone.verified_name ?? null,
      wabaName: waba.name ?? null,
      wabaCurrency: waba.currency ?? null,
      webhookSubscribed: true,
    },
  };
}

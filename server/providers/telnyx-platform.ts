import { getEnv } from "@/server/env";
import { providerJson } from "@/server/providers/http";

const BASE_URL = "https://api.telnyx.com/v2";

export type TelnyxAvailableNumber = {
  phoneNumber: string;
  countryCode: string;
  administrativeArea: string | null;
  locality: string | null;
  numberType: string;
  monthlyCost: string;
  upfrontCost: string;
  currency: string;
  bestEffort: boolean;
};

type CostInformation = {
  monthly_cost?: string;
  upfront_cost?: string;
  currency?: string;
};

type RegionInformation = {
  region_name?: string;
  region_type?: string;
};

function telnyxConfig() {
  const env = getEnv();
  const apiKey = env.HOSTED_TELNYX_API_KEY?.trim() || env.HOSTED_SMS_TELNYX_API_KEY?.trim();
  const webhookPublicKey = env.HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY?.trim() || env.HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY?.trim();
  if (!apiKey) throw new Error("Managed Telnyx telephony is not configured. HOSTED_TELNYX_API_KEY is required.");
  if (!webhookPublicKey) throw new Error("Managed Telnyx telephony is not configured. HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY is required.");
  return { apiKey, webhookPublicKey };
}

function authHeaders(apiKey: string) {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

function regionValue(regions: RegionInformation[] | undefined, type: string) {
  return regions?.find((region) => region.region_type === type)?.region_name ?? null;
}

export function getHostedTelnyxCredentials() {
  return telnyxConfig();
}

export async function searchTelnyxNumbers(input: {
  countryCode: "US";
  administrativeArea?: string | null;
  locality?: string | null;
  areaCode?: string | null;
  numberType?: "local" | "toll_free";
  startsWith?: string | null;
  limit?: number;
}, fetcher: typeof fetch = fetch): Promise<TelnyxAvailableNumber[]> {
  const { apiKey } = telnyxConfig();
  const params = new URLSearchParams();
  params.set("filter[country_code]", input.countryCode);
  // Telnyx documents this filter as a feature list; requiring SMS narrows inventory, and we verify both SMS + voice on every returned row below.
  params.set("filter[features]", "sms");
  params.set("filter[phone_number_type]", input.numberType === "toll_free" ? "toll-free" : "local");
  params.set("filter[limit]", String(Math.min(Math.max(input.limit ?? 12, 1), 30)));
  params.set("filter[best_effort]", "false");
  params.set("filter[exclude_held_numbers]", "true");
  if (input.numberType === "toll_free") params.set("filter[quickship]", "true");
  if (input.administrativeArea?.trim()) params.set("filter[administrative_area]", input.administrativeArea.trim().toUpperCase());
  if (input.locality?.trim()) params.set("filter[locality]", input.locality.trim());
  if (input.areaCode?.trim()) params.set("filter[national_destination_code]", input.areaCode.replace(/\D/g, ""));
  if (input.startsWith?.trim()) params.set("filter[starts_with]", input.startsWith.replace(/\D/g, ""));

  const response = await providerJson<{
    data?: Array<{
      phone_number?: string;
      cost_information?: CostInformation;
      region_information?: RegionInformation[];
      best_effort?: boolean;
      features?: Array<{ name?: string } | string>;
    }>;
  }>(`${BASE_URL}/available_phone_numbers?${params.toString()}`, {
    headers: authHeaders(apiKey),
  }, fetcher);

  return (response.data ?? []).flatMap((row) => {
    if (!row.phone_number || !row.cost_information?.monthly_cost) return [];
    const features = (row.features ?? []).map((feature) => typeof feature === "string" ? feature : feature.name).filter(Boolean);
    if (!features.includes("voice") || !features.includes("sms")) return [];
    return [{
      phoneNumber: row.phone_number,
      countryCode: input.countryCode,
      administrativeArea: regionValue(row.region_information, "state") ?? regionValue(row.region_information, "administrative_area"),
      locality: regionValue(row.region_information, "rate_center") ?? regionValue(row.region_information, "locality"),
      numberType: input.numberType ?? "local",
      monthlyCost: row.cost_information.monthly_cost,
      upfrontCost: row.cost_information.upfront_cost ?? "0",
      currency: row.cost_information.currency ?? "USD",
      bestEffort: row.best_effort === true,
    }];
  });
}

export async function createTelnyxCallControlApplication(
  workspaceId: string,
  webhookUrl: string,
  fetcher: typeof fetch = fetch,
) {
  const { apiKey } = telnyxConfig();
  const response = await providerJson<{ data?: { id?: string } }>(`${BASE_URL}/call_control_applications`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      application_name: `AI Caller ${workspaceId}`,
      webhook_event_url: webhookUrl,
      webhook_api_version: "2",
      active: true,
    }),
  }, fetcher);
  const id = response.data?.id;
  if (!id) throw new Error("Telnyx did not return a Call Control application ID.");
  return id;
}

export async function createTelnyxMessagingProfile(
  workspaceId: string,
  webhookUrl: string,
  fetcher: typeof fetch = fetch,
) {
  const { apiKey } = telnyxConfig();
  const response = await providerJson<{ data?: { id?: string } }>(`${BASE_URL}/messaging_profiles`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      name: `AI Caller ${workspaceId}`,
      webhook_url: webhookUrl,
      webhook_api_version: "2",
      enabled: true,
      whitelisted_destinations: ["US"],
    }),
  }, fetcher);
  const id = response.data?.id;
  if (!id) throw new Error("Telnyx did not return a Messaging Profile ID.");
  return id;
}

export async function orderTelnyxNumber(input: {
  workspaceId: string;
  phoneNumber: string;
  connectionId: string;
  messagingProfileId: string;
}, fetcher: typeof fetch = fetch) {
  const { apiKey } = telnyxConfig();
  const response = await providerJson<{
    data?: {
      id?: string;
      status?: string;
      requirements_met?: boolean;
      phone_numbers?: Array<{ id?: string; phone_number?: string; status?: string; requirements_met?: boolean }>;
    };
  }>(`${BASE_URL}/number_orders`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      phone_numbers: [{ phone_number: input.phoneNumber }],
      connection_id: input.connectionId,
      messaging_profile_id: input.messagingProfileId,
      customer_reference: `ai-caller:${input.workspaceId}`,
    }),
  }, fetcher);
  const order = response.data;
  if (!order?.id) throw new Error("Telnyx did not return a phone number order ID.");
  return order;
}

export async function findOwnedTelnyxNumber(phoneNumber: string, fetcher: typeof fetch = fetch) {
  const { apiKey } = telnyxConfig();
  const digits = phoneNumber.replace(/\D/g, "");
  const params = new URLSearchParams({ "filter[phone_number]": digits, "page[size]": "20" });
  const response = await providerJson<{ data?: Array<{ id?: string; phone_number?: string; status?: string }> }>(
    `${BASE_URL}/phone_numbers?${params.toString()}`,
    { headers: authHeaders(apiKey) },
    fetcher,
  );
  return (response.data ?? []).find((row) => row.phone_number === phoneNumber) ?? null;
}

export async function releaseTelnyxNumber(providerNumberId: string, fetcher: typeof fetch = fetch) {
  const { apiKey } = telnyxConfig();
  await providerJson(`${BASE_URL}/phone_numbers/${encodeURIComponent(providerNumberId)}`, {
    method: "DELETE",
    headers: authHeaders(apiKey),
  }, fetcher);
}

export async function deleteTelnyxCallControlApplication(id: string, fetcher: typeof fetch = fetch) {
  const { apiKey } = telnyxConfig();
  await providerJson(`${BASE_URL}/call_control_applications/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(apiKey),
  }, fetcher);
}

export async function deleteTelnyxMessagingProfile(id: string, fetcher: typeof fetch = fetch) {
  const { apiKey } = telnyxConfig();
  await providerJson(`${BASE_URL}/messaging_profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(apiKey),
  }, fetcher);
}

import { getEnv } from "@/server/env";
import { ProviderRequestError, providerJson } from "@/server/providers/http";
import { isE2EProviderFixtureMode } from "@/server/providers/e2e-fixtures";

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

export type TelnyxNumberOrderPhoneNumber = {
  id?: string;
  phone_number?: string;
  status?: string;
  requirements_met?: boolean;
};

export type TelnyxNumberOrder = {
  id?: string;
  status?: string;
  requirements_met?: boolean;
  customer_reference?: string;
  phone_numbers?: TelnyxNumberOrderPhoneNumber[];
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

function numberOrderCustomerReference(workspaceId: string, requestId: string) {
  return `ai-caller:${workspaceId}:${requestId}`;
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
  endsWith?: string | null;
  limit?: number;
}, fetcher: typeof fetch = fetch): Promise<TelnyxAvailableNumber[]> {
  if (isE2EProviderFixtureMode()) {
    const startsWith = input.startsWith?.replace(/\D/g, "") ?? "";
    const area = input.areaCode?.replace(/\D/g, "") || (input.numberType === "toll_free" ? "888" : "202");
    const phoneNumber = startsWith.length >= 10
      ? `+1${startsWith.slice(0, 10)}`
      : input.numberType === "toll_free" ? "+18885550100" : `+1${area}5550200`;
    return [{
      phoneNumber,
      countryCode: "US",
      administrativeArea: input.administrativeArea?.trim().toUpperCase() || "DC",
      locality: input.locality?.trim() || "Washington",
      numberType: input.numberType ?? "local",
      monthlyCost: "1.00",
      upfrontCost: "0.00",
      currency: "USD",
      bestEffort: false,
    }];
  }
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
  if (input.endsWith?.trim()) params.set("filter[ends_with]", input.endsWith.replace(/\D/g, ""));

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
  if (isE2EProviderFixtureMode()) return `e2e-call-control-${workspaceId}`;
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

// A tunnel hostname can change during local acceptance. Repair only the known
// workspace-owned Call Control application; never buy another number to fix it.
export async function updateTelnyxCallControlApplication(
  workspaceId: string,
  applicationId: string,
  webhookUrl: string,
  fetcher: typeof fetch = fetch,
) {
  if (isE2EProviderFixtureMode()) return applicationId;
  const { apiKey } = telnyxConfig();
  const response = await providerJson<{ data?: { id?: string } }>(
    `${BASE_URL}/call_control_applications/${encodeURIComponent(applicationId)}`,
    {
      method: "PATCH",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        application_name: `AI Caller ${workspaceId}`,
        webhook_event_url: webhookUrl,
      }),
    },
    fetcher,
  );
  if (response.data?.id !== applicationId) {
    throw new Error("Telnyx did not confirm the expected Call Control application.");
  }
  return applicationId;
}

export async function createTelnyxMessagingProfile(
  workspaceId: string,
  webhookUrl: string,
  fetcher: typeof fetch = fetch,
) {
  if (isE2EProviderFixtureMode()) return `e2e-messaging-profile-${workspaceId}`;
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
  requestId: string;
  phoneNumber: string;
  connectionId: string;
  messagingProfileId: string;
}, fetcher: typeof fetch = fetch): Promise<TelnyxNumberOrder> {
  const customerReference = numberOrderCustomerReference(input.workspaceId, input.requestId);
  if (isE2EProviderFixtureMode()) {
    return {
      id: `e2e-order-${input.requestId}`,
      status: "pending",
      requirements_met: true,
      customer_reference: customerReference,
      phone_numbers: [{
        id: `e2e-number-${input.phoneNumber.replace(/\D/g, "")}`,
        phone_number: input.phoneNumber,
        status: "pending",
        requirements_met: true,
      }],
    };
  }
  const { apiKey } = telnyxConfig();
  const response = await providerJson<{ data?: TelnyxNumberOrder }>(`${BASE_URL}/number_orders`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      phone_numbers: [{ phone_number: input.phoneNumber }],
      connection_id: input.connectionId,
      messaging_profile_id: input.messagingProfileId,
      customer_reference: customerReference,
    }),
  }, fetcher);
  const order = response.data;
  if (!order?.id) throw new Error("Telnyx did not return a phone number order ID.");
  return order;
}

export async function findTelnyxNumberOrderByReference(input: {
  workspaceId: string;
  requestId: string;
  phoneNumber: string;
}, fetcher: typeof fetch = fetch): Promise<TelnyxNumberOrder | null> {
  const customerReference = numberOrderCustomerReference(input.workspaceId, input.requestId);
  if (isE2EProviderFixtureMode()) return null;

  const { apiKey } = telnyxConfig();
  const params = new URLSearchParams({
    "filter[customer_reference]": customerReference,
    "page[size]": "20",
  });
  const response = await providerJson<{ data?: TelnyxNumberOrder[] }>(
    `${BASE_URL}/number_orders?${params.toString()}`,
    { headers: authHeaders(apiKey) },
    fetcher,
  );
  return (response.data ?? []).find((order) =>
    order.customer_reference === customerReference
    && (order.phone_numbers ?? []).some((number) => number.phone_number === input.phoneNumber)
  ) ?? null;
}

export async function retrieveTelnyxNumberOrder(orderId: string, fetcher: typeof fetch = fetch): Promise<TelnyxNumberOrder> {
  if (isE2EProviderFixtureMode()) {
    const requestId = orderId.replace(/^e2e-order-/, "");
    return {
      id: orderId,
      status: "pending",
      requirements_met: true,
      customer_reference: `e2e:${requestId}`,
      phone_numbers: [],
    };
  }
  const { apiKey } = telnyxConfig();
  const response = await providerJson<{ data?: TelnyxNumberOrder }>(
    `${BASE_URL}/number_orders/${encodeURIComponent(orderId)}`,
    { headers: authHeaders(apiKey) },
    fetcher,
  );
  if (!response.data?.id) throw new Error("Telnyx did not return the phone number order.");
  return response.data;
}

export async function retrieveTelnyxOrderPhoneNumber(orderPhoneNumberId: string, fetcher: typeof fetch = fetch): Promise<TelnyxNumberOrderPhoneNumber> {
  if (isE2EProviderFixtureMode()) {
    return { id: orderPhoneNumberId, status: "success", requirements_met: true };
  }
  const { apiKey } = telnyxConfig();
  const response = await providerJson<{ data?: TelnyxNumberOrderPhoneNumber }>(
    `${BASE_URL}/number_order_phone_numbers/${encodeURIComponent(orderPhoneNumberId)}`,
    { headers: authHeaders(apiKey) },
    fetcher,
  );
  if (!response.data?.id) throw new Error("Telnyx did not return the ordered phone number.");
  return response.data;
}

export async function findOwnedTelnyxNumber(phoneNumber: string, fetcher: typeof fetch = fetch) {
  if (isE2EProviderFixtureMode()) {
    return { id: `e2e-number-${phoneNumber.replace(/\D/g, "")}`, phone_number: phoneNumber, status: "active" };
  }
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
  if (isE2EProviderFixtureMode()) return;
  const { apiKey } = telnyxConfig();
  try {
    await providerJson(`${BASE_URL}/phone_numbers/${encodeURIComponent(providerNumberId)}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    }, fetcher);
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) return;
    throw error;
  }
}

export async function deleteTelnyxCallControlApplication(id: string, fetcher: typeof fetch = fetch) {
  if (isE2EProviderFixtureMode()) return;
  const { apiKey } = telnyxConfig();
  try {
    await providerJson(`${BASE_URL}/call_control_applications/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    }, fetcher);
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) return;
    throw error;
  }
}

export async function deleteTelnyxMessagingProfile(id: string, fetcher: typeof fetch = fetch) {
  if (isE2EProviderFixtureMode()) return;
  const { apiKey } = telnyxConfig();
  try {
    await providerJson(`${BASE_URL}/messaging_profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    }, fetcher);
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) return;
    throw error;
  }
}

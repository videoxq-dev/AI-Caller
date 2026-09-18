import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  getEnv: () => ({
    HOSTED_TELNYX_API_KEY: "test-key",
    HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY: "test-public-key",
    HOSTED_SMS_TELNYX_API_KEY: undefined,
    HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY: undefined,
  }),
}));

import { orderTelnyxNumber, searchTelnyxNumbers } from "./telnyx-platform";

describe("managed Telnyx number search", () => {
  it("sends state, city and area-code filters and requires voice + SMS", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("filter[country_code]")).toBe("US");
      expect(url.searchParams.get("filter[administrative_area]")).toBe("WY");
      expect(url.searchParams.get("filter[locality]")).toBe("Sheridan");
      expect(url.searchParams.get("filter[national_destination_code]")).toBe("307");
      expect(url.searchParams.get("filter[features]")).toBe("sms");
      return new Response(JSON.stringify({
        data: [{
          phone_number: "+13075550184",
          cost_information: { monthly_cost: "1.10", upfront_cost: "0.00", currency: "USD" },
          features: [{ name: "voice" }, { name: "sms" }],
          region_information: [
            { region_type: "state", region_name: "WY" },
            { region_type: "locality", region_name: "Sheridan" },
          ],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await searchTelnyxNumbers({
      countryCode: "US",
      administrativeArea: "WY",
      locality: "Sheridan",
      areaCode: "307",
    }, fetcher);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      phoneNumber: "+13075550184",
      administrativeArea: "WY",
      locality: "Sheridan",
      monthlyCost: "1.10",
    });
  });

  it("requests quickship inventory for US toll-free numbers", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("filter[phone_number_type]")).toBe("toll-free");
      expect(url.searchParams.get("filter[quickship]")).toBe("true");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    await searchTelnyxNumbers({ countryCode: "US", numberType: "toll_free" }, fetcher);
  });

  it("returns the purchased phone-number id supplied by the order response", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        connection_id: "connection-1",
        messaging_profile_id: "profile-1",
      });
      return new Response(JSON.stringify({
        data: {
          id: "order-1",
          status: "success",
          requirements_met: true,
          phone_numbers: [{
            id: "number-1",
            phone_number: "+13075550184",
            status: "success",
            requirements_met: true,
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await expect(orderTelnyxNumber({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      phoneNumber: "+13075550184",
      connectionId: "connection-1",
      messagingProfileId: "profile-1",
    }, fetcher)).resolves.toMatchObject({
      id: "order-1",
      phone_numbers: [{ id: "number-1", phone_number: "+13075550184" }],
    });
  });
});

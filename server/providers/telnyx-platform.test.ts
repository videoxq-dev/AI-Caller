import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/providers/e2e-fixtures", () => ({
  isE2EProviderFixtureMode: () => false,
}));

vi.mock("@/server/env", () => ({
  getEnv: () => ({
    HOSTED_TELNYX_API_KEY: "test-key",
    HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY: "test-public-key",
    HOSTED_SMS_TELNYX_API_KEY: undefined,
    HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY: undefined,
  }),
}));

import { deleteTelnyxCallControlApplication, deleteTelnyxMessagingProfile, findTelnyxNumberOrderByReference, orderTelnyxNumber, releaseTelnyxNumber, retrieveTelnyxNumberOrder, retrieveTelnyxOrderPhoneNumber, searchTelnyxNumbers, updateTelnyxCallControlApplication } from "./telnyx-platform";

describe("managed Telnyx number search", () => {
  it("updates the exact existing Call Control app to a new public callback without a purchase", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({
      data: { id: "app-123" },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(updateTelnyxCallControlApplication(
      "workspace-abc", "app-123", "https://my-test-tunnel.ngrok-free.app/api/webhooks/voice/telnyx/workspace-abc", fetcher,
    )).resolves.toBe("app-123");
    const [url, init] = vi.mocked(fetcher).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/call_control_applications/app-123");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      application_name: "AI Caller workspace-abc",
      webhook_event_url: "https://my-test-tunnel.ngrok-free.app/api/webhooks/voice/telnyx/workspace-abc",
    });
  });

  it("rejects an update response that does not confirm the owned connection ID", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { id: "some-other-connection" },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(updateTelnyxCallControlApplication(
      "workspace-abc", "app-123", "https://my-test-tunnel.ngrok-free.app/api/webhooks/voice/telnyx/workspace-abc", fetcher,
    )).rejects.toThrow("Telnyx did not confirm the expected Call Control application.");
  });

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

  it("finds an indeterminate purchase by unique customer reference and exact phone number", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v2/number_orders");
      expect(url.searchParams.get("filter[customer_reference]")).toBe(
        "ai-caller:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
      );
      expect(url.searchParams.get("page[size]")).toBe("20");
      return new Response(JSON.stringify({
        data: [
          {
            id: "wrong-order",
            status: "pending",
            customer_reference: "ai-caller:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
            phone_numbers: [{ id: "wrong-number", phone_number: "+13075550999" }],
          },
          {
            id: "order-1",
            status: "pending",
            customer_reference: "ai-caller:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
            phone_numbers: [{ id: "order-number-1", phone_number: "+13075550184" }],
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await expect(findTelnyxNumberOrderByReference({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      requestId: "22222222-2222-4222-8222-222222222222",
      phoneNumber: "+13075550184",
    }, fetcher)).resolves.toMatchObject({
      id: "order-1",
      phone_numbers: [{ id: "order-number-1", phone_number: "+13075550184" }],
    });
  });

  it("retrieves order and ordered-number state for carrier reconciliation", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/number_orders/order-1")) {
        return new Response(JSON.stringify({
          data: { id: "order-1", status: "pending", requirements_met: true },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/number_order_phone_numbers/order-number-1")) {
        return new Response(JSON.stringify({
          data: { id: "order-number-1", phone_number: "+13075550184", status: "success", requirements_met: true },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected Telnyx test URL: ${url}`);
    }) as typeof fetch;

    await expect(retrieveTelnyxNumberOrder("order-1", fetcher)).resolves.toMatchObject({
      id: "order-1",
      status: "pending",
    });
    await expect(retrieveTelnyxOrderPhoneNumber("order-number-1", fetcher)).resolves.toMatchObject({
      id: "order-number-1",
      status: "success",
    });
  });

  it("treats already-deleted carrier resources as successful cleanup", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      errors: [{ detail: "Not found" }],
    }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;

    await expect(releaseTelnyxNumber("number-1", fetcher)).resolves.toBeUndefined();
    await expect(deleteTelnyxCallControlApplication("connection-1", fetcher)).resolves.toBeUndefined();
    await expect(deleteTelnyxMessagingProfile("profile-1", fetcher)).resolves.toBeUndefined();
  });

  it("returns the purchased phone-number id supplied by the order response", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        connection_id: "connection-1",
        messaging_profile_id: "profile-1",
        customer_reference: "ai-caller:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
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
      requestId: "22222222-2222-4222-8222-222222222222",
      phoneNumber: "+13075550184",
      connectionId: "connection-1",
      messagingProfileId: "profile-1",
    }, fetcher)).resolves.toMatchObject({
      id: "order-1",
      phone_numbers: [{ id: "number-1", phone_number: "+13075550184" }],
    });
  });
});

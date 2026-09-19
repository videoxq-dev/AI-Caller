import { describe, expect, it, vi } from "vitest";
import { telnyxRegistrationClient } from "./registration-provider";

vi.mock("@/server/providers/telnyx-platform", () => ({
  getHostedTelnyxCredentials: () => ({ apiKey: "test-registration-api-key" }),
}));

function httpFixture(response: unknown, status = 200) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(response), {
      status, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { client: telnyxRegistrationClient(fetcher), requests };
}

describe("Telnyx 10DLC and toll-free transport contracts", () => {
  it("links the exact managed number to the registered campaign with bearer authentication", async () => {
    const { client, requests } = httpFixture({
      phoneNumber: "+12025550200", campaignId: "TCR-ID", telnyxCampaignId: "telnyx-campaign",
      assignmentStatus: "ASSIGNED",
    });
    const result = await client.assignNumber("+12025550200", "telnyx-campaign");
    expect(result.telnyxCampaignId).toBe("telnyx-campaign");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.telnyx.com/v2/10dlc/phone_number_campaigns");
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.headers).toMatchObject({ authorization: "Bearer test-registration-api-key" });
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      phoneNumber: "+12025550200", campaignId: "telnyx-campaign",
    });
  });

  it("URL-encodes an E.164 phone number in the campaign-assignment lookup", async () => {
    const { client, requests } = httpFixture({
      phoneNumber: "+12025550200", telnyxCampaignId: "telnyx-campaign", assignmentStatus: "ASSIGNED",
    });
    await client.getAssignment("+12025550200");
    expect(requests[0].url).toBe("https://api.telnyx.com/v2/10dlc/phone_number_campaigns/%2B12025550200");
  });

  it("filters existing toll-free verification requests by exact phone number before resubmitting", async () => {
    const { client, requests } = httpFixture({
      records: [
        { id: "other", phoneNumbers: [{ phoneNumber: "+18885550111" }] },
        { id: "existing", phoneNumbers: [{ phoneNumber: "+18885550200" }] },
      ],
    });
    expect((await client.findTollFreeByNumber("+18885550200"))?.id).toBe("existing");
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/v2/messaging_tollfree/verification/requests");
    expect(url.searchParams.get("phone_number")).toBe("+18885550200");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("page_size")).toBe("30");
  });

  it("does not treat Telnyx API errors as successful registration", async () => {
    const { client } = httpFixture({ error: "Invalid business data" }, 422);
    await expect(client.getBrand("invalid-brand")).rejects.toMatchObject({
      status: 422, message: "Invalid business data",
    });
  });
});

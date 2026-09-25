import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getCommercialWorkspaceOwner, requireCommercialProviderPurchaser } from "@/server/auth/commercial-ownership";
import { bindCapability, listIntegrations, saveIntegration, setIntegrationStatus, testSavedIntegration } from "@/server/domain/integrations/repository";
import {
  getWorkspaceIntegrationEntitlements,
  requireCapabilityBindingEntitlement,
  requireProviderIntegrationEntitlement,
} from "@/server/commerce/workspace-entitlements";
import { AppError } from "@/server/http/errors";
import { exchangeOAuthCode, getOAuthAuthorizationUrl } from "@/server/providers/oauth";
import { GET as listProviders, PATCH as disconnectProvider, POST as saveProvider } from "./route";
import { GET as listBindings, PUT as bindProvider } from "./capabilities/route";
import { resolveProviderRoute } from "@/server/providers/resolver";
import { GET as startOAuth } from "./oauth/[provider]/start/route";
import { PUT as updateSmsConfig } from "./sms/config/route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/auth/commercial-ownership", () => ({
  getCommercialWorkspaceOwner: vi.fn().mockResolvedValue(null),
  requireCommercialProviderPurchaser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/auth/permissions", () => ({ requireWorkspacePermission: vi.fn() }));
vi.mock("@/server/commerce/workspace-entitlements", () => ({
  getWorkspaceIntegrationEntitlements: vi.fn().mockResolvedValue({ externalCalendar: false, nonCalendarByopEnabled: false }),
  requireCapabilityBindingEntitlement: vi.fn(),
  requireProviderIntegrationEntitlement: vi.fn(),
}));
vi.mock("@/server/domain/integrations/repository", () => ({
  bindCapability: vi.fn(),
  getPrivateIntegration: vi.fn().mockResolvedValue(null),
  listIntegrations: vi.fn().mockResolvedValue([]),
  saveIntegration: vi.fn(),
  setIntegrationStatus: vi.fn(),
  testSavedIntegration: vi.fn(),
}));
vi.mock("@/server/providers/resolver", () => ({ resolveProviderRoute: vi.fn().mockResolvedValue(null) }));
vi.mock("@/server/providers/oauth", () => ({
  createOAuthState: vi.fn().mockReturnValue("signed-state"),
  getOAuthAuthorizationUrl: vi.fn().mockReturnValue("https://provider.example/oauth"),
  exchangeOAuthCode: vi.fn(),
  verifyOAuthState: vi.fn(),
}));

describe("external integration route entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      session: { user: { id: "purchaser" } },
      workspace: { id: "workspace-core" },
      membership: { role: "OWNER" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
  });

  it("blocks delegated client OWNER from saving provider credentials before any provider call", async () => {
    vi.mocked(requireCommercialProviderPurchaser).mockRejectedValueOnce(
      new AppError("COMMERCIAL_PURCHASER_REQUIRED", "Only the purchaser can manage provider infrastructure.", 403),
    );
    const response = await saveProvider(new Request("https://app.example.com/api/integrations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", category: "AI", mode: "BYOP", credentials: { apiKey: "secret" }, settings: {} }),
    }));
    expect(response.status).toBe(403);
    expect(saveIntegration).not.toHaveBeenCalled();
    expect(testSavedIntegration).not.toHaveBeenCalled();
  });

  it("blocks delegated client OWNER from disconnecting purchaser BYOP credentials after a refund", async () => {
    vi.mocked(requireCommercialProviderPurchaser).mockRejectedValueOnce(
      new AppError("COMMERCIAL_PURCHASER_REQUIRED", "Only the purchaser can manage provider infrastructure.", 403),
    );
    const response = await disconnectProvider(new Request("https://app.example.com/api/integrations", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "telnyx", status: "DISCONNECTED" }),
    }));
    expect(response.status).toBe(403);
    expect(setIntegrationStatus).not.toHaveBeenCalled();
  });

  it("hides purchaser provider records from delegated client integration listings", async () => {
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      session: { user: { id: "delegated-client" } },
      workspace: { id: "workspace-core" },
      membership: { role: "OWNER" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
    vi.mocked(getCommercialWorkspaceOwner).mockResolvedValueOnce({
      purchaserUserId: "purchaser", kind: "ADDITIONAL", agencyClient: true, createdAt: new Date(),
    });
    vi.mocked(listIntegrations).mockResolvedValueOnce([
      { provider: "openai", settings: { model: "private-model" } },
      { provider: "whatsapp", settings: { businessId: "own-business" } },
      { provider: "calcom", settings: { org: "private-org" } },
    ] as Awaited<ReturnType<typeof listIntegrations>>);
    const response = await listProviders(new Request("https://app.example.com/api/integrations"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.integrations).toMatchObject([{ provider: "whatsapp" }]);
    expect(JSON.stringify(data)).not.toContain("private-model");
    expect(JSON.stringify(data)).not.toContain("private-org");
  });

  it("does not expose purchaser AI, SMS or voice provider settings through capability GET", async () => {
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      session: { user: { id: "client-owner" } },
      workspace: { id: "agency-client" },
      membership: { role: "OWNER" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
    vi.mocked(getCommercialWorkspaceOwner).mockResolvedValueOnce({
      purchaserUserId: "purchaser", kind: "ADDITIONAL",
      agencyClient: true, createdAt: new Date(),
    });
    vi.mocked(getWorkspaceIntegrationEntitlements).mockResolvedValueOnce({
      purchaserUserId: "purchaser", externalCalendar: false,
      performanceAutomations: false, whitelabelEligible: true, nonCalendarByopEnabled: false,
    });
    const response = await listBindings(new Request("https://app.example.com/api/integrations/capabilities"));
    expect(response.status).toBe(200);
    expect((await response.json()).capabilities).toMatchObject({
      AI_TEXT: null, SMS: null, VOICE: null,
    });
    expect(resolveProviderRoute).toHaveBeenCalledTimes(2);
    expect(resolveProviderRoute).toHaveBeenCalledWith("agency-client", "WHATSAPP");
    expect(resolveProviderRoute).toHaveBeenCalledWith("agency-client", "CALENDAR");
  });

  it("blocks direct external calendar credentials before persistence or provider testing", async () => {
    vi.mocked(requireProviderIntegrationEntitlement).mockRejectedValueOnce(
      new AppError("EXTERNAL_CALENDAR_REQUIRES_UNLIMITED", "Upgrade to Unlimited to connect an external calendar.", 403),
    );
    const response = await saveProvider(new Request("https://app.example.com/api/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "calcom", category: "CALENDAR", mode: "BYOP",
        credentials: { apiKey: "never-persist" }, settings: {},
      }),
    }));
    expect(response.status).toBe(403);
    expect(saveIntegration).not.toHaveBeenCalled();
    expect(testSavedIntegration).not.toHaveBeenCalled();
  });

  it("blocks Google OAuth before generating a provider authorization URL", async () => {
    vi.mocked(requireProviderIntegrationEntitlement).mockRejectedValueOnce(
      new AppError("EXTERNAL_CALENDAR_REQUIRES_UNLIMITED", "Upgrade to Unlimited to connect an external calendar.", 403),
    );
    const response = await startOAuth(
      new Request("https://app.example.com/api/integrations/oauth/google/start"),
      { params: Promise.resolve({ provider: "google" }) },
    );
    expect(response.status).toBe(403);
    expect(getOAuthAuthorizationUrl).not.toHaveBeenCalled();
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("blocks direct BYOP SMS configuration before reading saved provider state", async () => {
    vi.mocked(requireProviderIntegrationEntitlement).mockRejectedValueOnce(
      new AppError("BYOP_REQUIRES_WHITELABEL", "Bring-your-own-provider infrastructure requires Agency and Whitelabel.", 403),
    );
    const response = await updateSmsConfig(new Request("https://app.example.com/api/integrations/sms/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "twilio", phone: "+15551234567" }),
    }));
    expect(response.status).toBe(403);
    expect(saveIntegration).not.toHaveBeenCalled();
  });

  it("blocks a delegated client OWNER from switching AI, SMS or voice onto hosted credits", async () => {
    for (const capability of ["AI_TEXT", "SMS", "VOICE"] as const) {
      vi.mocked(requireCommercialProviderPurchaser).mockRejectedValueOnce(
        new AppError("COMMERCIAL_PURCHASER_REQUIRED", "Only the purchaser can manage provider infrastructure.", 403),
      );
      const response = await bindProvider(new Request("https://app.example.com/api/integrations/capabilities", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability, mode: "HOSTED" }),
      }));
      expect(response.status).toBe(403);
      expect(bindCapability).not.toHaveBeenCalled();
      expect(requireCapabilityBindingEntitlement).not.toHaveBeenCalled();
    }
  });

  it("blocks non-calendar BYOP capability binding before changing runtime routing", async () => {
    vi.mocked(requireCapabilityBindingEntitlement).mockRejectedValueOnce(
      new AppError("BYOP_REQUIRES_WHITELABEL", "Bring-your-own-provider infrastructure requires Agency and Whitelabel.", 403),
    );
    const response = await bindProvider(new Request("https://app.example.com/api/integrations/capabilities", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "AI_TEXT", mode: "BYOP", provider: "openai" }),
    }));
    expect(response.status).toBe(403);
    expect(bindCapability).not.toHaveBeenCalled();
  });
});

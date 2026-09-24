import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { bindCapability, saveIntegration, testSavedIntegration } from "@/server/domain/integrations/repository";
import {
  requireCapabilityBindingEntitlement,
  requireProviderIntegrationEntitlement,
} from "@/server/commerce/workspace-entitlements";
import { AppError } from "@/server/http/errors";
import { exchangeOAuthCode, getOAuthAuthorizationUrl } from "@/server/providers/oauth";
import { POST as saveProvider } from "./route";
import { PUT as bindProvider } from "./capabilities/route";
import { GET as startOAuth } from "./oauth/[provider]/start/route";
import { PUT as updateSmsConfig } from "./sms/config/route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/auth/permissions", () => ({ requireWorkspacePermission: vi.fn() }));
vi.mock("@/server/commerce/workspace-entitlements", () => ({
  getWorkspaceIntegrationEntitlements: vi.fn().mockResolvedValue({ externalCalendar: false, agencyByop: false }),
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
      workspace: { id: "workspace-core" },
      membership: { role: "OWNER" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
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
      new AppError("BYOP_REQUIRES_AGENCY", "Bring-your-own-provider integrations are available on Agency.", 403),
    );
    const response = await updateSmsConfig(new Request("https://app.example.com/api/integrations/sms/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "twilio", phone: "+15551234567" }),
    }));
    expect(response.status).toBe(403);
    expect(saveIntegration).not.toHaveBeenCalled();
  });

  it("blocks non-calendar BYOP capability binding before changing runtime routing", async () => {
    vi.mocked(requireCapabilityBindingEntitlement).mockRejectedValueOnce(
      new AppError("BYOP_REQUIRES_AGENCY", "Bring-your-own-provider integrations are available on Agency.", 403),
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

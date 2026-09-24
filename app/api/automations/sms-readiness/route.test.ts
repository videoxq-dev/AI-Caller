import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { smsAutomationReadiness } from "@/server/sms/automation-readiness";
import { GET } from "./route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/sms/automation-readiness", () => ({ smsAutomationReadiness: vi.fn() }));

describe("SMS automation readiness API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("resolves only the authenticated workspace and disables caching", async () => {
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      workspace: { id: "workspace-one" },
      membership: { role: "STAFF" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
    vi.mocked(smsAutomationReadiness).mockResolvedValue({
      status: "REGISTRATION_REQUIRED", categories: [],
      message: "Registration needed", setupUrl: "/settings?tab=phone#sms-registration",
    });
    const response = await GET(new Request("https://app.example.com/api/automations/sms-readiness"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      readiness: { status: "REGISTRATION_REQUIRED", categories: [] },
    });
    expect(smsAutomationReadiness).toHaveBeenCalledExactlyOnceWith("workspace-one");
  });

  it("does not query readiness without a workspace session", async () => {
    vi.mocked(resolveWorkspaceContext).mockRejectedValue(new Error("No session"));
    const response = await GET(new Request("https://app.example.com/api/automations/sms-readiness"));
    expect(response.status).toBe(500);
    expect(smsAutomationReadiness).not.toHaveBeenCalled();
  });
});

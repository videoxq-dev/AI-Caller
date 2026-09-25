import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getEffectiveWorkspaceSeatPlan } from "@/server/billing/plans";
import { readActiveWorkspaceId } from "./active-workspace";
import { getMembership, getPrimaryMembership } from "./workspace-repository";
import { resolveWorkspaceContext } from "./workspace-context";

vi.mock("@/server/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/server/admin/auth", () => ({ assertPlatformUserActive: vi.fn() }));
vi.mock("@/server/billing/plans", () => ({ getEffectiveWorkspaceSeatPlan: vi.fn() }));
vi.mock("./active-workspace", () => ({ readActiveWorkspaceId: vi.fn() }));
vi.mock("./workspace-repository", () => ({
  getMembership: vi.fn(), getPrimaryMembership: vi.fn(), ensureDefaultWorkspace: vi.fn(),
}));

describe("commercially effective staff-session seats", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "staff-member", name: "Member", email: "member@example.com" },
    } as Awaited<ReturnType<typeof auth.api.getSession>>);
    vi.mocked(getPrimaryMembership).mockResolvedValue({
      workspaceId: "staff-business", workspaceName: "Business",
      workspaceStatus: "ACTIVE", role: "STAFF",
    });
    vi.mocked(readActiveWorkspaceId).mockReturnValue(null);
  });

  it("permits staff when Unlimited provides seats over a Personal base plan", async () => {
    vi.mocked(getEffectiveWorkspaceSeatPlan).mockResolvedValue({
      plan: { subUserLimit: 5 }, commercialSeatPackage: "UNLIMITED",
    } as Awaited<ReturnType<typeof getEffectiveWorkspaceSeatPlan>>);
    const result = await resolveWorkspaceContext(new Headers());
    expect(result.membership.role).toBe("STAFF");
    expect(getEffectiveWorkspaceSeatPlan).toHaveBeenCalledWith("staff-business");
    expect(assertPlatformUserActive).toHaveBeenCalledWith("staff-member");
  });

  it("denies Agency client staff when Core allows no seats", async () => {
    vi.mocked(getEffectiveWorkspaceSeatPlan).mockResolvedValue({
      plan: { subUserLimit: 0 }, commercialSeatPackage: null,
    } as Awaited<ReturnType<typeof getEffectiveWorkspaceSeatPlan>>);
    await expect(resolveWorkspaceContext(new Headers()))
      .rejects.toMatchObject({ code: "PLAN_SUBUSER_ACCESS_DISABLED", status: 403 });
  });

  it("preserves the delegated client OWNER exemption from staff seat limits", async () => {
    vi.mocked(getPrimaryMembership).mockResolvedValue({
      workspaceId: "client", workspaceName: "Client",
      workspaceStatus: "ACTIVE", role: "OWNER",
    });
    await expect(resolveWorkspaceContext(new Headers())).resolves.toMatchObject({
      workspace: { id: "client" }, membership: { role: "OWNER" },
    });
    expect(getEffectiveWorkspaceSeatPlan).not.toHaveBeenCalled();
  });

  it("does not honor an active-workspace cookie without membership", async () => {
    vi.mocked(readActiveWorkspaceId).mockReturnValue("other-client");
    vi.mocked(getMembership).mockResolvedValue(null);
    vi.mocked(getEffectiveWorkspaceSeatPlan).mockResolvedValue({
      plan: { subUserLimit: 5 }, commercialSeatPackage: "UNLIMITED",
    } as Awaited<ReturnType<typeof getEffectiveWorkspaceSeatPlan>>);
    await expect(resolveWorkspaceContext(new Headers())).resolves.toMatchObject({
      workspace: { id: "staff-business" },
    });
  });
});

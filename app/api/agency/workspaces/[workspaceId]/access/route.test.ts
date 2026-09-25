import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { listWorkspaceTeam } from "@/server/auth/team-repository";
import { getWorkspaceSeatUsage } from "@/server/billing/plans";
import { requireAgencyManagedWorkspace } from "@/server/agency/access";
import { GET } from "./route";

vi.mock("@/server/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/server/admin/auth", () => ({ assertPlatformUserActive: vi.fn() }));
vi.mock("@/server/auth/team-repository", () => ({ listWorkspaceTeam: vi.fn() }));
vi.mock("@/server/billing/plans", () => ({ getWorkspaceSeatUsage: vi.fn() }));
vi.mock("@/server/agency/access", () => ({ requireAgencyManagedWorkspace: vi.fn() }));

const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("Agency managed workspace access API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "agency-owner", email: "owner@example.com" },
    } as Awaited<ReturnType<typeof auth.api.getSession>>);
    vi.mocked(requireAgencyManagedWorkspace).mockResolvedValue({
      workspaceId,
      workspaceName: "Client Business",
      workspaceStatus: "ACTIVE",
      kind: "ADDITIONAL",
      purchaserUserId: "agency-owner",
    });
    vi.mocked(listWorkspaceTeam).mockResolvedValue({
      members: [
        { userId: "agency-owner", name: "Agency Owner", email: "owner@example.com", image: null, role: "OWNER", joinedAt: new Date() },
        { userId: "client-owner", name: "Client Owner", email: "client@example.com", image: null, role: "OWNER", joinedAt: new Date() },
        { userId: "staff-1", name: "Staff", email: "staff@example.com", image: null, role: "STAFF", joinedAt: new Date() },
      ],
      invitations: [
        { id: "33333333-3333-4333-8333-333333333333", email: "admin@example.com", role: "ADMIN", status: "PENDING", expiresAt: new Date(), createdAt: new Date(), invitedByUserId: "agency-owner" },
      ],
    });
    vi.mocked(getWorkspaceSeatUsage).mockResolvedValue({
      plan: {
        id: "GROWTH",
        name: "Growth",
        description: null,
        active: true,
        subUserLimit: 3,
        metadata: {},
        source: "TEST",
      },
      commercialSeatPackage: null,
      activeSubUsers: 1,
      pendingInvitations: 1,
      usedSeats: 2,
      availableSeats: 1,
    });
  });

  it("separates commercial owner, client owner and ordinary team access", async () => {
    const response = await GET(
      new Request("https://app.example.com/api/agency/workspaces/" + workspaceId + "/access"),
      { params: Promise.resolve({ workspaceId }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.members).toMatchObject([
      { userId: "agency-owner", accessKind: "AGENCY_OWNER", role: "OWNER" },
      { userId: "client-owner", accessKind: "CLIENT_OWNER", role: "OWNER" },
      { userId: "staff-1", accessKind: "TEAM", role: "STAFF" },
    ]);
    expect(payload.plan).toMatchObject({ usedSeats: 2, availableSeats: 1, subUserLimit: 3 });
    expect(requireAgencyManagedWorkspace).toHaveBeenCalledWith("agency-owner", workspaceId);
  });

  it("requires authentication before reading a client's team", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const response = await GET(
      new Request("https://app.example.com/api/agency/workspaces/" + workspaceId + "/access"),
      { params: Promise.resolve({ workspaceId }) },
    );
    expect(response.status).toBe(401);
    expect(requireAgencyManagedWorkspace).not.toHaveBeenCalled();
    expect(listWorkspaceTeam).not.toHaveBeenCalled();
  });
});

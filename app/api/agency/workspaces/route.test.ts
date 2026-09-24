import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getOwnedWorkspaceCapacity, getPrimaryOwnedWorkspace, listMembershipsForUser } from "@/server/auth/workspace-repository";
import { GET } from "./route";

vi.mock("@/server/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/server/admin/auth", () => ({ assertPlatformUserActive: vi.fn() }));
vi.mock("@/server/auth/workspace-repository", () => ({
  getOwnedWorkspaceCapacity: vi.fn(),
  getPrimaryOwnedWorkspace: vi.fn(),
  listMembershipsForUser: vi.fn(),
}));

const owned = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Owner Business",
  workspaceStatus: "ACTIVE" as const,
  role: "OWNER" as const,
};
const client = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceName: "Client Business",
  workspaceStatus: "ACTIVE" as const,
  role: "OWNER" as const,
};
const staff = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  workspaceName: "Another Owner's Business",
  workspaceStatus: "ACTIVE" as const,
  role: "STAFF" as const,
};

const request = (cookie?: string) => new Request("https://app.example.com/api/agency/workspaces", {
  headers: cookie ? { cookie: `ai-caller-active-workspace=${cookie}` } : {},
});

describe("Agency workspace management API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "agency-buyer", email: "buyer@example.com" },
    } as Awaited<ReturnType<typeof auth.api.getSession>>);
    vi.mocked(getOwnedWorkspaceCapacity).mockResolvedValue({
      ownedBusinesses: 2, businessLimit: 51, availableBusinesses: 49,
      agencyClientLimit: 50, agencyClientsUsed: 1, agencyClientsAvailable: 49,
      activeProducts: ["CORE", "AGENCY_50"],
    });
    vi.mocked(getPrimaryOwnedWorkspace).mockResolvedValue(owned);
    vi.mocked(listMembershipsForUser).mockResolvedValue([owned, staff, client]);
  });

  it("returns owned client workspaces and excludes staff access from Agency inventory", async () => {
    const response = await GET(request(client.workspaceId));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      workspaces: [owned, client],
      originalWorkspaceId: owned.workspaceId,
      activeWorkspaceId: client.workspaceId,
      capacity: { agencyClientLimit: 50, agencyClientsUsed: 1, agencyClientsAvailable: 49 },
    });
    expect(listMembershipsForUser).toHaveBeenCalledExactlyOnceWith("agency-buyer");
    expect(assertPlatformUserActive).toHaveBeenCalledExactlyOnceWith("agency-buyer");
  });

  it("does not treat a selected staff workspace as an owned Agency client", async () => {
    const response = await GET(request(staff.workspaceId));
    expect(response.status).toBe(200);
    expect((await response.json()).activeWorkspaceId).toBeNull();
  });

  it("refuses Core, Unlimited and refunded Agency buyers before reading inventory", async () => {
    vi.mocked(getOwnedWorkspaceCapacity).mockResolvedValue({
      ownedBusinesses: 2, businessLimit: 2, availableBusinesses: 0,
      agencyClientLimit: null, agencyClientsUsed: null, agencyClientsAvailable: null,
      activeProducts: ["CORE", "UNLIMITED"],
    });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("AGENCY_REQUIRED");
    expect(listMembershipsForUser).not.toHaveBeenCalled();
  });

  it("requires authentication before reading commercial account data", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(getOwnedWorkspaceCapacity).not.toHaveBeenCalled();
  });
});

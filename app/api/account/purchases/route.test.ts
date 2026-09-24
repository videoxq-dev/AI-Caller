import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getOwnedWorkspaceCapacity } from "@/server/auth/workspace-repository";
import { getFunnelAccountSummary } from "@/server/commerce/account-licenses";
import { GET } from "./route";

vi.mock("@/server/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/server/admin/auth", () => ({ assertPlatformUserActive: vi.fn() }));
vi.mock("@/server/auth/workspace-repository", () => ({ getOwnedWorkspaceCapacity: vi.fn() }));
vi.mock("@/server/commerce/account-licenses", () => ({ getFunnelAccountSummary: vi.fn() }));

const request = () => new Request("https://app.example.com/api/account/purchases");

describe("authenticated funnel purchase summary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "buyer-1", email: "buyer@example.com" },
    } as Awaited<ReturnType<typeof auth.api.getSession>>);
    vi.mocked(getFunnelAccountSummary).mockResolvedValue({
      activeProducts: ["CORE"], businessLimit: 1,
      licenses: [
        { id: "core-license", workspaceId: "buyer-business", productCode: "CORE", status: "ACTIVE", purchasedAt: new Date("2026-09-01T10:00:00Z") },
        { id: "unlimited-license", workspaceId: "buyer-business", productCode: "UNLIMITED", status: "REFUNDED", purchasedAt: new Date("2026-09-02T10:00:00Z") },
      ],
    });
    vi.mocked(getOwnedWorkspaceCapacity).mockResolvedValue({
      ownedBusinesses: 1, businessLimit: 1, availableBusinesses: 0, activeProducts: ["CORE"],
    });
  });

  it("returns only the signed-in purchaser's recorded licenses and account capacity", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      activeProducts: ["CORE"],
      businessLimit: 1, ownedBusinesses: 1, availableBusinesses: 0,
      licenses: [
        { id: "core-license", productCode: "CORE", status: "ACTIVE" },
        { id: "unlimited-license", productCode: "UNLIMITED", status: "REFUNDED" },
      ],
    });
    expect(getFunnelAccountSummary).toHaveBeenCalledExactlyOnceWith("buyer-1");
    expect(getOwnedWorkspaceCapacity).toHaveBeenCalledExactlyOnceWith("buyer-1");
    expect(assertPlatformUserActive).toHaveBeenCalledExactlyOnceWith("buyer-1");
  });

  it("rejects unauthenticated requests without querying anyone's receipts", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(getFunnelAccountSummary).not.toHaveBeenCalled();
    expect(getOwnedWorkspaceCapacity).not.toHaveBeenCalled();
  });

  it("respects account suspension and does not require an active workspace", async () => {
    vi.mocked(assertPlatformUserActive).mockRejectedValue(
      Object.assign(new Error("Account suspended"), { code: "USER_SUSPENDED", status: 403 }),
    );
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(getFunnelAccountSummary).not.toHaveBeenCalled();
    expect(getOwnedWorkspaceCapacity).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getKnowledgeSourceUsage, listKnowledgeSources } from "@/server/knowledge/repository";
import { AppError } from "@/server/http/errors";
import { GET } from "./route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/knowledge/repository", () => ({
  listKnowledgeSources: vi.fn(), getKnowledgeSourceUsage: vi.fn(),
}));

describe("workspace knowledge entitlement API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      workspace: { id: "workspace-a" },
      membership: { role: "STAFF" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
    vi.mocked(listKnowledgeSources).mockResolvedValue([]);
    vi.mocked(getKnowledgeSourceUsage).mockResolvedValue({
      count: 0, limit: 0, package: null,
    });
  });

  it("shows Core has no knowledge upload entitlement", async () => {
    const response = await GET(new Request("https://app.example.com/api/knowledge"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(listKnowledgeSources).toHaveBeenCalledExactlyOnceWith("workspace-a", 30);
    expect(getKnowledgeSourceUsage).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(await response.json()).toEqual({ sources: [], count: 0, limit: 0, package: null });
  });

  it("shows Unlimited has exactly two source slots", async () => {
    vi.mocked(getKnowledgeSourceUsage).mockResolvedValue({
      count: 1, limit: 2, package: "UNLIMITED",
    });
    const response = await GET(new Request("https://app.example.com/api/knowledge"));
    expect(await response.json()).toMatchObject({ count: 1, limit: 2, package: "UNLIMITED" });
  });

  it("rejects unauthenticated access before fetching knowledge", async () => {
    vi.mocked(resolveWorkspaceContext).mockRejectedValue(new AppError("UNAUTHORIZED", "Sign in required.", 401));
    const response = await GET(new Request("https://app.example.com/api/knowledge"));
    expect(response.status).toBe(401);
    expect(listKnowledgeSources).not.toHaveBeenCalled();
  });
});

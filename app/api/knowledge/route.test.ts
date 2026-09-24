import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getKnowledgeSourceUsage, listKnowledgeSources } from "@/server/knowledge/repository";
import { GET } from "./route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/knowledge/repository", () => ({
  listKnowledgeSources: vi.fn(), getKnowledgeSourceUsage: vi.fn(),
}));

describe("paginated workspace knowledge API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      workspace: { id: "workspace-a" },
      membership: { role: "STAFF" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
    vi.mocked(listKnowledgeSources).mockResolvedValue([{
      id: "source-one", kind: "FILE", label: "handbook.md", sourceUrl: null,
      contentHash: "safe-hash", createdAt: new Date(), updatedAt: new Date(),
    }] as Awaited<ReturnType<typeof listKnowledgeSources>>);
    vi.mocked(getKnowledgeSourceUsage).mockResolvedValue({
      count: 51, limit: 500, package: "UNLIMITED",
    });
  });

  it("returns only workspace-scoped metadata and a bounded next page", async () => {
    const response = await GET(new Request("https://app.example.com/api/knowledge?offset=30&limit=20"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(listKnowledgeSources).toHaveBeenCalledExactlyOnceWith("workspace-a", 20, 30);
    expect(getKnowledgeSourceUsage).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(await response.json()).toMatchObject({
      sources: [{ id: "source-one", label: "handbook.md" }],
      total: 51, limit: 500, package: "UNLIMITED", nextOffset: 31,
    });
  });

  it("does not fetch unbounded or invalid pages", async () => {
    const response = await GET(new Request("https://app.example.com/api/knowledge?offset=-1&limit=1000000"));
    expect(response.status).toBe(400);
    expect(listKnowledgeSources).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated access before fetching knowledge", async () => {
    vi.mocked(resolveWorkspaceContext).mockRejectedValue(new Error("Unauthorized"));
    const response = await GET(new Request("https://app.example.com/api/knowledge"));
    expect(response.status).toBe(500);
    expect(listKnowledgeSources).not.toHaveBeenCalled();
  });
});

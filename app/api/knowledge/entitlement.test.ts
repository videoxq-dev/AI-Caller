import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { getKnowledgeSourceUsage, saveKnowledgeSource } from "@/server/knowledge/repository";
import { importWebsiteText } from "@/server/knowledge/website-import";
import { POST as uploadFile } from "./files/route";
import { POST as importWebsite } from "./website/route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/auth/permissions", () => ({ requireWorkspacePermission: vi.fn() }));
vi.mock("@/server/knowledge/repository", () => ({
  getKnowledgeSourceUsage: vi.fn(), saveKnowledgeSource: vi.fn(),
}));
vi.mock("@/server/knowledge/website-import", () => ({ importWebsiteText: vi.fn() }));

describe("knowledge upload entitlement at route boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      workspace: { id: "core-business" }, membership: { role: "OWNER" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
    vi.mocked(getKnowledgeSourceUsage).mockResolvedValue({ count: 0, limit: 0, package: null });
  });

  it("denies Core website imports before fetching an external URL", async () => {
    const response = await importWebsite(new Request("https://app.example.com/api/knowledge/website", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }));
    expect(response.status).toBe(403);
    expect(importWebsiteText).not.toHaveBeenCalled();
    expect(saveKnowledgeSource).not.toHaveBeenCalled();
    expect(requireWorkspacePermission).toHaveBeenCalledWith("OWNER", "integration.manage");
  });

  it("denies Core file uploads without reading and buffering the request body", async () => {
    const response = await uploadFile(new Request("https://app.example.com/api/knowledge/files", {
      method: "POST", body: "not multipart",
    }));
    expect(response.status).toBe(403);
    expect(saveKnowledgeSource).not.toHaveBeenCalled();
  });

  it("continues normal file validation for an Unlimited owner", async () => {
    vi.mocked(getKnowledgeSourceUsage).mockResolvedValue({ count: 1, limit: 2, package: "UNLIMITED" });
    const response = await uploadFile(new Request("https://app.example.com/api/knowledge/files", {
      method: "POST",
    }));
    expect(response.status).toBe(422);
  });
});

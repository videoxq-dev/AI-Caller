import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { resolveWhatsAppTemplatesForWorkspace } from "@/server/providers/whatsapp/runtime";
import { GET } from "./route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/providers/whatsapp/runtime", () => ({
  resolveWhatsAppTemplatesForWorkspace: vi.fn(),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const template = (name: string, status: string, textOnly = true) => ({
  name, language: "en_US", category: "UTILITY", status,
  body: "Hello {{1}}", textOnly, id: name, footer: "", rejectionReason: null,
});

describe("WhatsApp builder approved-template catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      workspace: { id: workspaceId, status: "ACTIVE" }, membership: { role: "OWNER" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
  });

  it("rejects staff access before retrieving a provider client", async () => {
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      workspace: { id: workspaceId, status: "ACTIVE" }, membership: { role: "STAFF" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
    const response = await GET(new Request("https://app.example.com/api/automations/whatsapp-templates"));
    expect(response.status).toBe(403);
    expect(resolveWhatsAppTemplatesForWorkspace).not.toHaveBeenCalled();
  });

  it("filters pending, rejected and rich templates while retaining pagination", async () => {
    const list = vi.fn(async () => ({
      items: [template("pending", "PENDING"), template("rejected", "REJECTED"),
        template("rich", "APPROVED", false), template("ready", "APPROVED")],
      nextCursor: "cDoxOjc=",
    }));
    vi.mocked(resolveWhatsAppTemplatesForWorkspace).mockResolvedValue({ list } as never);
    const response = await GET(new Request("https://app.example.com/api/automations/whatsapp-templates"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      items: [{ name: "ready" }], nextCursor: "cDoxOjc=",
    });
    expect(resolveWhatsAppTemplatesForWorkspace).toHaveBeenCalledWith(workspaceId);
    const next = await GET(new Request("https://app.example.com/api/automations/whatsapp-templates?after=cDoxOjc%3D"));
    expect(next.status).toBe(200);
    expect(list).toHaveBeenLastCalledWith("cDoxOjc=");
  });

  it("rejects untrusted Meta cursors before resolving WABA credentials", async () => {
    const response = await GET(new Request(
      "https://app.example.com/api/automations/whatsapp-templates?after=https%3A%2F%2Fbad.example",
    ));
    expect(response.status).toBe(422);
    expect(resolveWhatsAppTemplatesForWorkspace).not.toHaveBeenCalled();
  });
});

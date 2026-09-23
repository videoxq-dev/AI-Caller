import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { resolveWhatsAppTemplatesForWorkspace } from "@/server/providers/whatsapp/runtime";
import { GET, POST } from "./route";

vi.mock("@/server/auth/workspace-context", () => ({ resolveWorkspaceContext: vi.fn() }));
vi.mock("@/server/providers/whatsapp/runtime", () => ({
  resolveWhatsAppTemplatesForWorkspace: vi.fn(),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const template = { name: "hello", language: "en_US", category: "UTILITY", body: "Hello", footer: "", samples: [] };

function request(method: string, body?: unknown, query = "") {
  return new Request(`https://app.example.com/api/integrations/whatsapp/templates${query}`, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}
function workspace(role: "OWNER" | "ADMIN" | "STAFF") {
  vi.mocked(resolveWorkspaceContext).mockResolvedValue({
    workspace: { id: workspaceId, name: "Acme", status: "ACTIVE" },
    membership: { role },
  } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
}
describe("WhatsApp template API workspace permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace("OWNER");
  });
  it("never resolves a Meta client for staff users", async () => {
    workspace("STAFF");
    const read = await GET(request("GET"));
    const write = await POST(request("POST", template));
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(resolveWhatsAppTemplatesForWorkspace).not.toHaveBeenCalled();
  });
  it("lists only the authenticated workspace WABA with a validated cursor", async () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: null }));
    vi.mocked(resolveWhatsAppTemplatesForWorkspace).mockResolvedValue({ list, submit: vi.fn() });
    const response = await GET(request("GET", undefined, "?after=cDoxOjc%3D"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveWhatsAppTemplatesForWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(list).toHaveBeenCalledWith("cDoxOjc=");
  });
  it("rejects untrusted cursors and invalid submissions before fetching workspace credentials", async () => {
    const badCursor = await GET(request("GET", undefined, "?after=https%3A%2F%2Fattacker.example"));
    expect(badCursor.status).toBe(422);
    const badBody = await POST(request("POST", { ...template, name: "Bad Name" }));
    expect(badBody.status).toBe(422);
    expect(resolveWhatsAppTemplatesForWorkspace).not.toHaveBeenCalled();
  });
  it("permits an admin to submit a pending template without claiming approval", async () => {
    workspace("ADMIN");
    const submit = vi.fn(async () => ({ id: "1", name: "hello", language: "en_US", status: "PENDING", category: "UTILITY" }));
    vi.mocked(resolveWhatsAppTemplatesForWorkspace).mockResolvedValue({ list: vi.fn(), submit });
    const response = await POST(request("POST", template));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ template: { status: "PENDING" } });
    expect(submit).toHaveBeenCalledWith(template);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { setWorkspaceAgentCapabilities, setWorkspaceAgentStatus } from "@/server/agent/service";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { PATCH as changeStatus } from "./status/route";
import { PATCH as changeCapabilities } from "./capabilities/route";

vi.mock("@/server/auth/workspace-context", () => ({
  resolveWorkspaceContext: vi.fn(),
}));
vi.mock("@/server/agent/service", () => ({
  setWorkspaceAgentStatus: vi.fn(),
  setWorkspaceAgentCapabilities: vi.fn(),
}));

function request(path: string, body: unknown) {
  return new Request(`http://localhost:3000/api/agent/${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("AI Agent management authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveWorkspaceContext).mockResolvedValue({
      workspace: { id: "workspace-a", name: "Workspace A", status: "ACTIVE" },
      membership: { role: "STAFF" },
    } as Awaited<ReturnType<typeof resolveWorkspaceContext>>);
  });

  it("rejects staff activation before calling the persistence service", async () => {
    const response = await changeStatus(request("status", { status: "ACTIVE" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(setWorkspaceAgentStatus).not.toHaveBeenCalled();
  });

  it("rejects staff capability edits before calling the persistence service", async () => {
    const response = await changeCapabilities(
      request("capabilities", { ...defaultAgentCapabilities, BOOK_APPOINTMENT: false }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(setWorkspaceAgentCapabilities).not.toHaveBeenCalled();
  });
});

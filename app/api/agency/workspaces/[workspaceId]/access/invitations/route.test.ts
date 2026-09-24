import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { issueWorkspaceInvitation } from "@/server/auth/workspace-invitation-service";
import { requireAgencyManagedWorkspace } from "@/server/agency/access";
import { POST } from "./route";

vi.mock("@/server/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/server/admin/auth", () => ({ assertPlatformUserActive: vi.fn() }));
vi.mock("@/server/auth/workspace-invitation-service", () => ({ issueWorkspaceInvitation: vi.fn() }));
vi.mock("@/server/agency/access", () => ({ requireAgencyManagedWorkspace: vi.fn() }));

const workspaceId = "22222222-2222-4222-8222-222222222222";

function request(role: "CLIENT_OWNER" | "ADMIN" | "STAFF") {
  return new Request("https://app.example.com/api/agency/workspaces/" + workspaceId + "/access/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "invitee@example.com", role }),
  });
}

describe("Agency managed workspace invitations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "agency-owner", name: "Agency Owner", email: "owner@example.com" },
    } as Awaited<ReturnType<typeof auth.api.getSession>>);
    vi.mocked(requireAgencyManagedWorkspace).mockResolvedValue({
      workspaceId,
      workspaceName: "Client Business",
      workspaceStatus: "ACTIVE",
      kind: "ADDITIONAL",
      purchaserUserId: "agency-owner",
    });
    vi.mocked(issueWorkspaceInvitation).mockResolvedValue({
      invitation: {
        id: "33333333-3333-4333-8333-333333333333",
        email: "invitee@example.com",
        role: "OWNER",
        expiresAt: new Date(),
      },
    });
  });

  it("maps Client owner to the existing OWNER membership role", async () => {
    const response = await POST(request("CLIENT_OWNER"), { params: Promise.resolve({ workspaceId }) });
    expect(response.status).toBe(201);
    expect(issueWorkspaceInvitation).toHaveBeenCalledWith({
      workspaceId,
      workspaceName: "Client Business",
      invitedByUserId: "agency-owner",
      inviterName: "Agency Owner",
      email: "invitee@example.com",
      role: "OWNER",
      rollbackActorRole: "OWNER",
    });
  });

  it("keeps Admin and Staff on the ordinary sub-user invitation path", async () => {
    vi.mocked(issueWorkspaceInvitation).mockResolvedValueOnce({
      invitation: {
        id: "44444444-4444-4444-8444-444444444444",
        email: "invitee@example.com",
        role: "STAFF",
        expiresAt: new Date(),
      },
    });
    expect((await POST(request("STAFF"), { params: Promise.resolve({ workspaceId }) })).status).toBe(201);
    expect(issueWorkspaceInvitation).toHaveBeenLastCalledWith(expect.objectContaining({ role: "STAFF" }));
  });

  it("does not allow a client-owner invitation on the Agency primary workspace", async () => {
    vi.mocked(requireAgencyManagedWorkspace).mockResolvedValueOnce({
      workspaceId,
      workspaceName: "Agency Business",
      workspaceStatus: "ACTIVE",
      kind: "PRIMARY",
      purchaserUserId: "agency-owner",
    });
    const response = await POST(request("CLIENT_OWNER"), { params: Promise.resolve({ workspaceId }) });
    expect(response.status).toBe(403);
    expect(issueWorkspaceInvitation).not.toHaveBeenCalled();
  });
});

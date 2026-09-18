import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDatabase } from "@/db";
import { memberships, user, workspaceInvitations, workspaces } from "@/db/schema";
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  listWorkspaceTeam,
  revokeWorkspaceInvitation,
} from "./team-repository";

const ownerId = "team-owner";
const staffId = "team-staff";
let workspaceId = "";

describe("workspace team invitations", () => {
  beforeEach(async () => {
    await db.delete(workspaceInvitations);
    await db.delete(memberships);
    await db.delete(workspaces);
    await db.delete(user);

    await db.insert(user).values([
      { id: ownerId, name: "Owner User", email: "owner@example.com", emailVerified: true },
      { id: staffId, name: "Staff User", email: "staff@example.com", emailVerified: true },
    ]);
    const [workspace] = await db.insert(workspaces).values({ name: "Team Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: ownerId, role: "OWNER" });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("accepts a matching invitation once and creates the requested membership", async () => {
    const created = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: " Staff@Example.com ",
      role: "STAFF",
    });

    await expect(acceptWorkspaceInvitation({
      userId: staffId,
      userEmail: "wrong@example.com",
      token: created.token,
    })).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });

    const accepted = await acceptWorkspaceInvitation({
      userId: staffId,
      userEmail: "staff@example.com",
      token: created.token,
    });
    expect(accepted).toEqual({ workspaceId, role: "STAFF" });

    const team = await listWorkspaceTeam(workspaceId);
    expect(team.members.some((member) => member.userId === staffId && member.role === "STAFF")).toBe(true);
    expect(team.invitations).toHaveLength(0);

    await expect(acceptWorkspaceInvitation({
      userId: staffId,
      userEmail: "staff@example.com",
      token: created.token,
    })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("prevents duplicate pending invitations and supports revoke", async () => {
    const created = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "staff@example.com",
      role: "STAFF",
    });

    await expect(createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "STAFF@example.com",
      role: "STAFF",
    })).rejects.toMatchObject({ code: "INVITATION_EXISTS" });

    await revokeWorkspaceInvitation(workspaceId, created.invitation.id);
    const replacement = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "staff@example.com",
      role: "ADMIN",
    });
    expect(replacement.invitation.role).toBe("ADMIN");
  });

  it("does not accept an expired token", async () => {
    const created = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "staff@example.com",
      role: "STAFF",
    });
    await db.update(workspaceInvitations).set({ expiresAt: new Date(Date.now() - 1_000) });

    await expect(acceptWorkspaceInvitation({
      userId: staffId,
      userEmail: "staff@example.com",
      token: created.token,
    })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });
});

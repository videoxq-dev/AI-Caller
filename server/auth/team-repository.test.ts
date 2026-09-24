import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDatabase } from "@/db";
import {
  automationSettings,
  contacts,
  conversations,
  leads,
  licenses,
  memberships,
  user,
  workspaceCommercialOwners,
  workspaceInvitations,
  workspacePlans,
  workspaces,
} from "@/db/schema";
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  listWorkspaceTeam,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
} from "./team-repository";
import { getWorkspaceSeatUsage } from "@/server/billing/plans";

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
    await db.insert(workspacePlans).values({
      workspaceId,
      planId: "GROWTH",
      source: "TEST",
    });
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

    await revokeWorkspaceInvitation(workspaceId, created.invitation.id, "OWNER");
    const replacement = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "staff@example.com",
      role: "ADMIN",
    });
    expect(replacement.invitation.role).toBe("ADMIN");
  });

  it("allows admins to revoke staff invitations but protects admin invitations", async () => {
    const staffInvite = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "staff-role@example.com",
      role: "STAFF",
    });
    await expect(revokeWorkspaceInvitation(workspaceId, staffInvite.invitation.id, "ADMIN"))
      .resolves.toMatchObject({ id: staffInvite.invitation.id });

    const adminInvite = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "admin-role@example.com",
      role: "ADMIN",
    });
    await expect(revokeWorkspaceInvitation(workspaceId, adminInvite.invitation.id, "ADMIN"))
      .rejects.toMatchObject({ code: "FORBIDDEN_ROLE_ASSIGNMENT", status: 403 });
    await expect(revokeWorkspaceInvitation(workspaceId, adminInvite.invitation.id, "OWNER"))
      .resolves.toMatchObject({ id: adminInvite.invitation.id });
  });

  it("lets an active Agency commercial owner invite one client owner without consuming a sub-user seat", async () => {
    await db.update(workspacePlans).set({ planId: "PERSONAL", updatedAt: new Date() });
    await db.insert(workspaceCommercialOwners).values({
      workspaceId,
      purchaserUserId: ownerId,
      kind: "ADDITIONAL",
    });
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: ownerId,
      source: "MANUAL",
      externalPurchaseId: "agency-client-owner-seat-exempt",
      productCode: "AGENCY_50",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });

    const created = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "staff@example.com",
      role: "OWNER",
    });
    expect(created.invitation.role).toBe("OWNER");
    expect(await getWorkspaceSeatUsage(workspaceId)).toMatchObject({
      plan: { id: "PERSONAL", subUserLimit: 0 },
      activeSubUsers: 0,
      pendingInvitations: 0,
      usedSeats: 0,
      availableSeats: 0,
    });

    await expect(acceptWorkspaceInvitation({
      userId: staffId,
      userEmail: "staff@example.com",
      token: created.token,
    })).resolves.toEqual({ workspaceId, role: "OWNER" });

    const team = await listWorkspaceTeam(workspaceId);
    expect(team.members.filter((member) => member.role === "OWNER")).toHaveLength(2);
    expect(await db.select().from(workspaceCommercialOwners))
      .toMatchObject([{ workspaceId, purchaserUserId: ownerId, kind: "ADDITIONAL" }]);
    expect(await getWorkspaceSeatUsage(workspaceId)).toMatchObject({
      activeSubUsers: 0,
      usedSeats: 0,
    });
  });

  it("prevents a second delegated client owner and rejects non-commercial owner invitations", async () => {
    await db.insert(workspaceCommercialOwners).values({
      workspaceId,
      purchaserUserId: ownerId,
      kind: "ADDITIONAL",
    });
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: ownerId,
      source: "MANUAL",
      externalPurchaseId: "agency-single-client-owner",
      productCode: "AGENCY_50",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });

    const first = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "first-client-owner@example.com",
      role: "OWNER",
    });
    await expect(createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "second-client-owner@example.com",
      role: "OWNER",
    })).rejects.toMatchObject({ code: "CLIENT_OWNER_INVITATION_EXISTS", status: 409 });

    await expect(createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: staffId,
      email: "not-commercial-owner@example.com",
      role: "OWNER",
    })).rejects.toMatchObject({ code: "AGENCY_COMMERCIAL_OWNER_REQUIRED", status: 403 });

    await revokeWorkspaceInvitation(workspaceId, first.invitation.id, "OWNER");
  });

  it("rechecks active Agency entitlement before a client owner accepts", async () => {
    await db.insert(workspaceCommercialOwners).values({
      workspaceId,
      purchaserUserId: ownerId,
      kind: "ADDITIONAL",
    });
    const [agency] = await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: ownerId,
      source: "MANUAL",
      externalPurchaseId: "agency-owner-acceptance-recheck",
      productCode: "AGENCY_50",
      status: "ACTIVE",
      purchasedAt: new Date(),
    }).returning();

    const created = await createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "staff@example.com",
      role: "OWNER",
    });
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, agency.id));

    await expect(acceptWorkspaceInvitation({
      userId: staffId,
      userEmail: "staff@example.com",
      token: created.token,
    })).rejects.toMatchObject({ code: "AGENCY_REQUIRED", status: 403 });

    expect((await listWorkspaceTeam(workspaceId)).members.some((member) => member.userId === staffId))
      .toBe(false);
  });

  it("blocks sub-user invitations on Personal", async () => {
    await db.update(workspacePlans).set({ planId: "PERSONAL", updatedAt: new Date() });

    await expect(createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "personal-staff@example.com",
      role: "STAFF",
    })).rejects.toMatchObject({ code: "PLAN_SEAT_LIMIT", status: 403 });
  });

  it("counts pending invitations against the Growth three-sub-user limit", async () => {
    for (const email of ["one@example.com", "two@example.com", "three@example.com"]) {
      await createWorkspaceInvitation({
        workspaceId,
        invitedByUserId: ownerId,
        email,
        role: "STAFF",
      });
    }

    await expect(createWorkspaceInvitation({
      workspaceId,
      invitedByUserId: ownerId,
      email: "four@example.com",
      role: "STAFF",
    })).rejects.toMatchObject({ code: "PLAN_SEAT_LIMIT", status: 403 });
  });

  it("clears lead and conversation assignments when a member is removed", async () => {
    await db.insert(memberships).values({ workspaceId, userId: staffId, role: "STAFF" });
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Assigned Customer" }).returning();
    const [conversation] = await db.insert(conversations).values({
      workspaceId,
      contactId: contact.id,
      assignedUserId: staffId,
    }).returning();
    const [lead] = await db.insert(leads).values({
      workspaceId,
      contactId: contact.id,
      assignedUserId: staffId,
    }).returning();
    await db.insert(automationSettings).values([
      {
        workspaceId,
        key: "QUALIFIED_LEAD_ASSIGNMENT",
        enabled: true,
        config: { assignedUserId: staffId, notifyInApp: true },
      },
      {
        workspaceId,
        key: "HUMAN_ESCALATION",
        enabled: true,
        config: { assignedUserId: staffId, notifyInApp: true },
      },
    ]);

    await removeWorkspaceMember(workspaceId, staffId);

    const [storedConversation] = await db.select().from(conversations);
    const [storedLead] = await db.select().from(leads);
    expect(storedConversation.id).toBe(conversation.id);
    expect(storedConversation.assignedUserId).toBeNull();
    expect(storedLead.id).toBe(lead.id);
    expect(storedLead.assignedUserId).toBeNull();
    const settings = await db.select().from(automationSettings);
    expect(settings).toHaveLength(2);
    expect(settings.every((setting) => setting.config.assignedUserId === null)).toBe(true);
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

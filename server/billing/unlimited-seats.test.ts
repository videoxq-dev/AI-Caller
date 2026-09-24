import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { licenses, memberships, user, workspacePlans, workspaces } from "@/db/schema";
import { getWorkspaceSeatUsage, assignWorkspacePlan } from "./plans";
import { createWorkspaceInvitation, acceptWorkspaceInvitation } from "@/server/auth/team-repository";

const userIds: string[] = [];
const workspaceIds: string[] = [];

async function makeUser() {
  const id = randomUUID();
  userIds.push(id);
  const email = "seat-test-" + id + "@example.com";
  await db.insert(user).values({ id, name: "Unlimited Seat Buyer", email, emailVerified: true });
  return { id, email };
}

async function makeWorkspace(ownerId: string) {
  const [workspace] = await db.insert(workspaces).values({ name: "Unlimited Seat Test" }).returning();
  workspaceIds.push(workspace.id);
  await db.insert(memberships).values({ workspaceId: workspace.id, userId: ownerId, role: "OWNER" });
  await db.insert(workspacePlans).values({ workspaceId: workspace.id, planId: "PERSONAL", source: "TEST" });
  return workspace.id;
}

async function grantUnlimited(ownerId: string, workspaceId: string) {
  const [license] = await db.insert(licenses).values({
    workspaceId, purchaserUserId: ownerId,
    source: "MANUAL", externalPurchaseId: randomUUID(), productCode: "UNLIMITED",
    status: "ACTIVE", purchasedAt: new Date(),
  }).returning();
  return license;
}

describe("Unlimited commercial team seats", () => {
  afterEach(async () => {
    for (const id of workspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
    workspaceIds.length = 0;
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    userIds.length = 0;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("preserves owner-only Personal before Unlimited is purchased", async () => {
    const owner = await makeUser();
    const workspaceId = await makeWorkspace(owner.id);
    const seats = await getWorkspaceSeatUsage(workspaceId);
    expect(seats).toMatchObject({
      plan: { id: "PERSONAL", subUserLimit: 0 },
      commercialSeatPackage: null,
      availableSeats: 0,
    });
    await expect(createWorkspaceInvitation({
      workspaceId, invitedByUserId: owner.id, email: "staff@example.com", role: "STAFF",
    })).rejects.toMatchObject({ code: "PLAN_SEAT_LIMIT" });
  });

  it("unlocks five staff on each business owned by the Unlimited purchaser", async () => {
    const owner = await makeUser();
    const originalId = await makeWorkspace(owner.id);
    const nextId = await makeWorkspace(owner.id);
    await grantUnlimited(owner.id, originalId);
    for (const workspaceId of [originalId, nextId]) {
      const seats = await getWorkspaceSeatUsage(workspaceId);
      expect(seats).toMatchObject({
        plan: { id: "PERSONAL", subUserLimit: 5 },
        commercialSeatPackage: "UNLIMITED",
        availableSeats: 5,
      });
    }
    for (let n = 1; n <= 5; n++) {
      await createWorkspaceInvitation({
        workspaceId: nextId, invitedByUserId: owner.id,
        email: "seat-" + n + "@example.com", role: "STAFF",
      });
    }
    const atCapacity = await getWorkspaceSeatUsage(nextId);
    expect(atCapacity).toMatchObject({ usedSeats: 5, availableSeats: 0 });
    await expect(createWorkspaceInvitation({
      workspaceId: nextId, invitedByUserId: owner.id, email: "sixth@example.com", role: "STAFF",
    })).rejects.toMatchObject({ code: "PLAN_SEAT_LIMIT", status: 403 });
  });

  it("does not let a STAFF's Unlimited purchase confer seats on someone else's business", async () => {
    const owner = await makeUser();
    const staff = await makeUser();
    const ownerWorkspace = await makeWorkspace(owner.id);
    const staffWorkspace = await makeWorkspace(staff.id);
    await db.insert(memberships).values({ workspaceId: ownerWorkspace, userId: staff.id, role: "STAFF" });
    await grantUnlimited(staff.id, staffWorkspace);
    expect(await getWorkspaceSeatUsage(ownerWorkspace)).toMatchObject({
      plan: { id: "PERSONAL", subUserLimit: 0 },
      commercialSeatPackage: null,
    });
  });

  it("retains existing seats after refund but blocks further invitations", async () => {
    const owner = await makeUser();
    const workspaceId = await makeWorkspace(owner.id);
    const license = await grantUnlimited(owner.id, workspaceId);
    await db.insert(memberships).values({ workspaceId, userId: (await makeUser()).id, role: "STAFF" });
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, license.id));
    expect(await getWorkspaceSeatUsage(workspaceId)).toMatchObject({
      plan: { id: "PERSONAL", subUserLimit: 0 },
      activeSubUsers: 1, availableSeats: 0,
    });
    await expect(createWorkspaceInvitation({
      workspaceId, invitedByUserId: owner.id, email: "new@example.com", role: "STAFF",
    })).rejects.toMatchObject({ code: "PLAN_SEAT_LIMIT" });
    const stillMember = await db.select().from(memberships).where(and(
      eq(memberships.workspaceId, workspaceId), eq(memberships.role, "STAFF"),
    ));
    expect(stillMember).toHaveLength(1);
  });

  it("allows a legacy billing plan downgrade while a separate active Unlimited purchase provides seats", async () => {
    const owner = await makeUser();
    const workspaceId = await makeWorkspace(owner.id);
    await assignWorkspacePlan(workspaceId, "GROWTH", "TEST");
    await grantUnlimited(owner.id, workspaceId);
    await db.insert(memberships).values([
      { workspaceId, userId: (await makeUser()).id, role: "STAFF" },
      { workspaceId, userId: (await makeUser()).id, role: "STAFF" },
      { workspaceId, userId: (await makeUser()).id, role: "STAFF" },
      { workspaceId, userId: (await makeUser()).id, role: "STAFF" },
    ]);
    await assignWorkspacePlan(workspaceId, "PERSONAL", "TEST");
    expect(await getWorkspaceSeatUsage(workspaceId)).toMatchObject({
      plan: { id: "PERSONAL", subUserLimit: 5 },
      usedSeats: 4, availableSeats: 1,
    });
  });

  it("permits an invited staff member to accept an Unlimited seat", async () => {
    const owner = await makeUser();
    const staff = await makeUser();
    const workspaceId = await makeWorkspace(owner.id);
    await grantUnlimited(owner.id, workspaceId);
    const invitation = await createWorkspaceInvitation({
      workspaceId, invitedByUserId: owner.id, email: staff.email, role: "STAFF",
    });
    await acceptWorkspaceInvitation({ userId: staff.id, userEmail: staff.email, token: invitation.token });
    expect(await getWorkspaceSeatUsage(workspaceId)).toMatchObject({
      activeSubUsers: 1, pendingInvitations: 0, availableSeats: 4,
    });
  });
});

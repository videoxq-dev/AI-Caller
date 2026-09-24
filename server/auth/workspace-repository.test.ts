import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { account, memberships, session, user, verification, workspaces } from "@/db/schema";
import { createWorkspaceForUser, ensureDefaultWorkspace, getPrimaryMembership, getPrimaryOwnedWorkspace, listMembershipsForUser } from "./workspace-repository";

const TEST_USER_ID = "workspace-test-user";

describe("workspace provisioning", () => {
  beforeEach(async () => {
    await db.delete(session);
    await db.delete(account);
    await db.delete(verification);
    await db.delete(memberships);
    await db.delete(workspaces);
    await db.delete(user);

    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "Alex Carter",
      email: "alex.workspace.test@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("creates one owner workspace and is idempotent", async () => {
    const first = await ensureDefaultWorkspace({
      id: TEST_USER_ID,
      name: "Alex Carter",
      email: "alex.workspace.test@example.com",
    });
    const second = await ensureDefaultWorkspace({
      id: TEST_USER_ID,
      name: "Alex Carter",
      email: "alex.workspace.test@example.com",
    });

    expect(first.workspaceId).toBe(second.workspaceId);
    expect(first.role).toBe("OWNER");

    const rows = await db.select().from(workspaces);
    expect(rows).toHaveLength(1);

    const membership = await getPrimaryMembership(TEST_USER_ID);
    expect(membership?.workspaceId).toBe(first.workspaceId);
  });

  it("creates an additional owner workspace with its own Personal plan", async () => {
    await ensureDefaultWorkspace({
      id: TEST_USER_ID,
      name: "Alex Carter",
      email: "alex.workspace.test@example.com",
    });

    const created = await createWorkspaceForUser(TEST_USER_ID, "Second Business");

    expect(created).toMatchObject({ workspaceName: "Second Business", role: "OWNER" });
    expect(await listMembershipsForUser(TEST_USER_ID)).toHaveLength(2);
  });


  it("selects a purchaser-owned business even when a staff workspace is older", async () => {
    const partnerId = "workspace-partner-user";
    await db.insert(user).values({
      id: partnerId,
      name: "Partner",
      email: "workspace.partner.test@example.com",
      emailVerified: true,
    });
    const [partnerWorkspace] = await db.insert(workspaces).values({ name: "Partner Business" }).returning();
    await db.insert(memberships).values([
      { workspaceId: partnerWorkspace.id, userId: partnerId, role: "OWNER" },
      { workspaceId: partnerWorkspace.id, userId: TEST_USER_ID, role: "STAFF" },
    ]);
    const owned = await createWorkspaceForUser(TEST_USER_ID, "My Purchased Business");

    expect((await getPrimaryMembership(TEST_USER_ID))?.workspaceId).toBe(partnerWorkspace.id);
    expect(await getPrimaryOwnedWorkspace(TEST_USER_ID)).toMatchObject({
      workspaceId: owned.workspaceId,
      role: "OWNER",
    });
  });
});

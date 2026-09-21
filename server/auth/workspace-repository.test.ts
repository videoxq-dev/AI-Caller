import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { account, memberships, session, user, verification, workspaces } from "@/db/schema";
import { createWorkspaceForUser, ensureDefaultWorkspace, getPrimaryMembership, listMembershipsForUser } from "./workspace-repository";

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
});

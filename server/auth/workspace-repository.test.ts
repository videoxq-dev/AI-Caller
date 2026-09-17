import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { account, memberships, session, user, verification, workspaces } from "@/db/schema";
import { ensureDefaultWorkspace, getPrimaryMembership } from "./workspace-repository";

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
});

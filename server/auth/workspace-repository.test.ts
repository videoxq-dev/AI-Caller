import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { account, licenses, memberships, session, user, verification, workspaces } from "@/db/schema";
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

  it("allows an initial buyer workspace but blocks an extra business without capacity", async () => {
    const first = await createWorkspaceForUser(TEST_USER_ID, "First Business");
    expect(first.role).toBe("OWNER");
    await expect(createWorkspaceForUser(TEST_USER_ID, "Second Business"))
      .rejects.toMatchObject({ code: "WORKSPACE_LIMIT_REACHED", status: 403 });
    expect(await listMembershipsForUser(TEST_USER_ID)).toHaveLength(1);
  });

  it("enforces Core's one-business limit regardless of refunded higher-tier purchases", async () => {
    const workspace = await createWorkspaceForUser(TEST_USER_ID, "Core Business");
    await db.insert(licenses).values([
      { workspaceId: workspace.workspaceId, purchaserUserId: TEST_USER_ID, source: "MANUAL", externalPurchaseId: randomUUID(), productCode: "CORE", status: "ACTIVE", purchasedAt: new Date() },
      { workspaceId: workspace.workspaceId, purchaserUserId: TEST_USER_ID, source: "MANUAL", externalPurchaseId: randomUUID(), productCode: "UNLIMITED", status: "REFUNDED", purchasedAt: new Date() },
    ]);
    await expect(createWorkspaceForUser(TEST_USER_ID, "Unlicensed Business"))
      .rejects.toMatchObject({ code: "WORKSPACE_LIMIT_REACHED" });
  });

  it("permits up to ten owned businesses under an active Unlimited license", async () => {
    const workspace = await createWorkspaceForUser(TEST_USER_ID, "First Business");
    await db.insert(licenses).values({ workspaceId: workspace.workspaceId, purchaserUserId: TEST_USER_ID, source: "MANUAL", externalPurchaseId: randomUUID(), productCode: "UNLIMITED", status: "ACTIVE", purchasedAt: new Date() });
    for (let business = 2; business <= 10; business++) {
      expect((await createWorkspaceForUser(TEST_USER_ID, "Business " + business)).role).toBe("OWNER");
    }
    await expect(createWorkspaceForUser(TEST_USER_ID, "Eleventh Business"))
      .rejects.toMatchObject({ code: "WORKSPACE_LIMIT_REACHED" });
    expect(await listMembershipsForUser(TEST_USER_ID)).toHaveLength(10);
  });

  it("serializes concurrent final-slot creation rather than exceeding the purchased limit", async () => {
    const workspace = await createWorkspaceForUser(TEST_USER_ID, "First Business");
    await db.insert(licenses).values({ workspaceId: workspace.workspaceId, purchaserUserId: TEST_USER_ID, source: "MANUAL", externalPurchaseId: randomUUID(), productCode: "UNLIMITED", status: "ACTIVE", purchasedAt: new Date() });
    for (let business = 2; business <= 9; business++) {
      await createWorkspaceForUser(TEST_USER_ID, "Business " + business);
    }
    const results = await Promise.allSettled([
      createWorkspaceForUser(TEST_USER_ID, "Concurrent A"),
      createWorkspaceForUser(TEST_USER_ID, "Concurrent B"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await listMembershipsForUser(TEST_USER_ID)).toHaveLength(10);
  });

  it("does not delete over-limit legacy workspaces while blocking new ones", async () => {
    await createWorkspaceForUser(TEST_USER_ID, "First Business");
    const [legacy] = await db.insert(workspaces).values({ name: "Existing Legacy Business" }).returning();
    await db.insert(memberships).values({ workspaceId: legacy.id, userId: TEST_USER_ID, role: "OWNER" });
    await expect(createWorkspaceForUser(TEST_USER_ID, "New Business"))
      .rejects.toMatchObject({ code: "WORKSPACE_LIMIT_REACHED" });
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

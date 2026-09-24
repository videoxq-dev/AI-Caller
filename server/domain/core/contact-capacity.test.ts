import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { contacts, licenses, memberships, user, workspaces } from "@/db/schema";
import { getContactCapacity } from "@/server/commerce/contact-capacity";
import { createContact, updateContact } from "./repository";

const userIds: string[] = [];
const workspaceIds: string[] = [];

async function makeUser(label: string) {
  const id = randomUUID();
  userIds.push(id);
  await db.insert(user).values({
    id,
    name: label,
    email: `${id}@example.com`,
    emailVerified: true,
  });
  return id;
}

async function makeWorkspace(ownerId: string) {
  const [workspace] = await db.insert(workspaces).values({ name: "Contact Capacity Test" }).returning();
  workspaceIds.push(workspace.id);
  await db.insert(memberships).values({ workspaceId: workspace.id, userId: ownerId, role: "OWNER" });
  return workspace.id;
}

async function grantUnlimited(ownerId: string, workspaceId: string) {
  const [license] = await db.insert(licenses).values({
    workspaceId,
    purchaserUserId: ownerId,
    source: "MANUAL",
    externalPurchaseId: randomUUID(),
    productCode: "UNLIMITED",
    status: "ACTIVE",
    purchasedAt: new Date(),
  }).returning();
  return license;
}

async function seedContacts(workspaceId: string, amount: number) {
  if (!amount) return [];
  return db.insert(contacts).values(Array.from({ length: amount }, (_, index) => ({
    workspaceId,
    name: `Seed ${index + 1}`,
  }))).returning({ id: contacts.id });
}

function input(name: string) {
  return {
    name,
    email: null,
    phone: null,
    notes: null,
    tags: [],
    identities: [],
  };
}

describe("Core and Unlimited contact capacity", () => {
  afterEach(async () => {
    for (const id of workspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
    workspaceIds.length = 0;
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    userIds.length = 0;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("allows exactly 500 contacts for Core and rejects contact 501", async () => {
    const ownerId = await makeUser("Core Buyer");
    const workspaceId = await makeWorkspace(ownerId);
    await seedContacts(workspaceId, 499);

    await expect(createContact(workspaceId, input("Contact 500"))).resolves.toMatchObject({
      name: "Contact 500",
    });
    await expect(createContact(workspaceId, input("Contact 501")))
      .rejects.toMatchObject({ code: "CONTACT_LIMIT_REACHED", status: 403 });

    await expect(getContactCapacity(workspaceId)).resolves.toEqual({
      count: 500,
      limit: 500,
      remaining: 0,
      package: null,
    });
  });

  it("serializes the final Core slot under concurrent contact creation", async () => {
    const ownerId = await makeUser("Concurrent Core Buyer");
    const workspaceId = await makeWorkspace(ownerId);
    await seedContacts(workspaceId, 499);

    const results = await Promise.allSettled([
      createContact(workspaceId, input("Concurrent A")),
      createContact(workspaceId, input("Concurrent B")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "CONTACT_LIMIT_REACHED", status: 403 },
    });
    expect((await getContactCapacity(workspaceId)).count).toBe(500);
  });

  it("removes the contact cap for businesses owned by an active Unlimited purchaser", async () => {
    const ownerId = await makeUser("Unlimited Buyer");
    const workspaceId = await makeWorkspace(ownerId);
    await grantUnlimited(ownerId, workspaceId);
    await seedContacts(workspaceId, 500);

    await expect(createContact(workspaceId, input("Contact 501"))).resolves.toMatchObject({
      name: "Contact 501",
    });
    await expect(getContactCapacity(workspaceId)).resolves.toEqual({
      count: 501,
      limit: null,
      remaining: null,
      package: "UNLIMITED",
    });
  });

  it("does not let a staff member's Unlimited purchase lift the owner's Core contact cap", async () => {
    const ownerId = await makeUser("Core Owner");
    const staffId = await makeUser("Unlimited Staff");
    const ownerWorkspaceId = await makeWorkspace(ownerId);
    const staffWorkspaceId = await makeWorkspace(staffId);
    await db.insert(memberships).values({ workspaceId: ownerWorkspaceId, userId: staffId, role: "STAFF" });
    await grantUnlimited(staffId, staffWorkspaceId);
    await seedContacts(ownerWorkspaceId, 500);

    await expect(createContact(ownerWorkspaceId, input("Blocked Contact")))
      .rejects.toMatchObject({ code: "CONTACT_LIMIT_REACHED" });
  });

  it("preserves over-limit contacts after an Unlimited refund while blocking new ones", async () => {
    const ownerId = await makeUser("Refunded Unlimited Buyer");
    const workspaceId = await makeWorkspace(ownerId);
    const license = await grantUnlimited(ownerId, workspaceId);
    const seeded = await seedContacts(workspaceId, 501);

    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, license.id));

    await expect(getContactCapacity(workspaceId)).resolves.toEqual({
      count: 501,
      limit: 500,
      remaining: 0,
      package: null,
    });
    await expect(updateContact(workspaceId, seeded[0].id, input("Still Editable")))
      .resolves.toMatchObject({ name: "Still Editable" });
    await expect(createContact(workspaceId, input("Blocked After Refund")))
      .rejects.toMatchObject({ code: "CONTACT_LIMIT_REACHED", status: 403 });

    const retained = await db.select({ id: contacts.id }).from(contacts)
      .where(eq(contacts.workspaceId, workspaceId));
    expect(retained).toHaveLength(501);
  });

  it("fails closed to the Core cap when workspace ownership is ambiguous", async () => {
    const ownerId = await makeUser("First Owner");
    const secondOwnerId = await makeUser("Second Owner");
    const workspaceId = await makeWorkspace(ownerId);
    await db.insert(memberships).values({ workspaceId, userId: secondOwnerId, role: "OWNER" });
    await grantUnlimited(ownerId, workspaceId);
    await seedContacts(workspaceId, 500);

    await expect(createContact(workspaceId, input("Ambiguous Owner Contact")))
      .rejects.toMatchObject({ code: "CONTACT_LIMIT_REACHED" });
    const owners = await db.select().from(memberships).where(and(
      eq(memberships.workspaceId, workspaceId),
      eq(memberships.role, "OWNER"),
    ));
    expect(owners).toHaveLength(2);
  });
});

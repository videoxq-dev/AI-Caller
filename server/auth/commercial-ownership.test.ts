import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { licenses, memberships, user, workspaceCommercialOwners, workspacePlans, workspaces } from "@/db/schema";
import {
  getCommercialWorkspaceOwner,
  requireCommercialProviderPurchaser,
  requireBrandedClientWorkspaceAccess,
  requireEffectiveWhitelabelPurchaser,
} from "./commercial-ownership";

const ids: string[] = [];
let purchaser = "";
let delegatedOwner = "";
let staff = "";
let outsider = "";
let original = "";
let client = "";

async function createUser(name: string) {
  const id = randomUUID();
  ids.push(id);
  await db.insert(user).values({ id, name, email: id + "@example.com", emailVerified: true });
  return id;
}

async function purchase(productCode: string, status: "ACTIVE" | "REFUNDED" = "ACTIVE") {
  await db.insert(licenses).values({
    workspaceId: original, purchaserUserId: purchaser,
    source: "MANUAL", externalPurchaseId: randomUUID(),
    productCode, status, purchasedAt: new Date(),
  });
}

describe("F12-B commercial owner and branded client authorization", () => {
  beforeEach(async () => {
    purchaser = await createUser("Agency Purchaser");
    delegatedOwner = await createUser("Client Owner");
    staff = await createUser("Client Staff");
    outsider = await createUser("Other Agency");
    const [primary] = await db.insert(workspaces).values({ name: "Purchaser Business" }).returning();
    original = primary.id;
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: original, purchaserUserId: purchaser, kind: "PRIMARY",
    });
    await db.insert(memberships).values({ workspaceId: original, userId: purchaser, role: "OWNER" });
    await purchase("CORE");
    await purchase("AGENCY_50");
    await purchase("WHITELABEL");
    const [additional] = await db.insert(workspaces).values({ name: "Client Business" }).returning();
    client = additional.id;
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: client, purchaserUserId: purchaser, kind: "ADDITIONAL",
    });
    await db.insert(memberships).values([
      { workspaceId: client, userId: purchaser, role: "OWNER" },
      { workspaceId: client, userId: delegatedOwner, role: "OWNER" },
      { workspaceId: client, userId: staff, role: "STAFF" },
    ]);
    await db.insert(workspacePlans).values({ workspaceId: client, planId: "GROWTH", source: "TEST" });
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, original));
    await db.delete(workspaces).where(eq(workspaces.id, client));
    for (const id of ids.splice(0)) await db.delete(user).where(eq(user.id, id));
  });
  afterAll(async () => closeDatabase());

  it("identifies the commercial purchaser independently of two operational OWNER memberships", async () => {
    expect(await getCommercialWorkspaceOwner(client)).toMatchObject({
      purchaserUserId: purchaser, kind: "ADDITIONAL",
    });
    expect(await getCommercialWorkspaceOwner(original)).toMatchObject({
      purchaserUserId: purchaser, kind: "PRIMARY",
    });
  });

  it("allows only the active purchaser to administer Whitelabel", async () => {
    expect(await requireEffectiveWhitelabelPurchaser(purchaser)).toEqual({
      purchaserUserId: purchaser, originalWorkspaceId: original,
    });
    await expect(requireEffectiveWhitelabelPurchaser(delegatedOwner))
      .rejects.toMatchObject({ code: "WHITELABEL_REQUIRED", status: 403 });
    await expect(requireEffectiveWhitelabelPurchaser(staff))
      .rejects.toMatchObject({ code: "WHITELABEL_REQUIRED", status: 403 });
  });

  it("allows only the commercial purchaser to manage provider keys, including safe cleanup after revocation", async () => {
    await expect(requireCommercialProviderPurchaser(purchaser, client))
      .resolves.toMatchObject({ purchaserUserId: purchaser });
    for (const actor of [delegatedOwner, staff, outsider]) {
      await expect(requireCommercialProviderPurchaser(actor, client))
        .rejects.toMatchObject({ code: "COMMERCIAL_PURCHASER_REQUIRED", status: 403 });
    }
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.productCode, "WHITELABEL"));
    await expect(requireCommercialProviderPurchaser(purchaser, client))
      .resolves.toMatchObject({ purchaserUserId: purchaser });
  });

  it("permits client OWNER and STAFF on the matching branded client workspace", async () => {
    expect((await requireBrandedClientWorkspaceAccess(delegatedOwner, client, purchaser)).role).toBe("OWNER");
    expect((await requireBrandedClientWorkspaceAccess(staff, client, purchaser)).role).toBe("STAFF");
  });

  it("prevents purchaser, other brand, strangers and original business from entering client-facing scope", async () => {
    await expect(requireBrandedClientWorkspaceAccess(purchaser, client, purchaser))
      .rejects.toMatchObject({ code: "BRANDED_CLIENT_ACCESS_DENIED", status: 403 });
    await expect(requireBrandedClientWorkspaceAccess(delegatedOwner, original, purchaser))
      .rejects.toMatchObject({ code: "BRANDED_WORKSPACE_NOT_FOUND", status: 404 });
    await expect(requireBrandedClientWorkspaceAccess(outsider, client, purchaser))
      .rejects.toMatchObject({ code: "BRANDED_WORKSPACE_NOT_FOUND", status: 404 });
    await expect(requireBrandedClientWorkspaceAccess(delegatedOwner, client, outsider))
      .rejects.toMatchObject({ code: "BRANDED_WORKSPACE_NOT_FOUND", status: 404 });
  });

  it("rejects branded access as soon as an Agency or Whitelabel prerequisite is revoked", async () => {
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.productCode, "AGENCY_50"));
    await expect(requireBrandedClientWorkspaceAccess(delegatedOwner, client, purchaser))
      .rejects.toMatchObject({ code: "WHITELABEL_REQUIRED", status: 403 });
    await db.update(licenses).set({ status: "ACTIVE" }).where(eq(licenses.productCode, "AGENCY_50"));
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.productCode, "WHITELABEL"));
    await expect(requireEffectiveWhitelabelPurchaser(purchaser))
      .rejects.toMatchObject({ code: "WHITELABEL_REQUIRED", status: 403 });
  });

  it("blocks suspended client businesses without blocking other purchaser businesses", async () => {
    await db.update(workspaces).set({ status: "SUSPENDED" }).where(eq(workspaces.id, client));
    await expect(requireBrandedClientWorkspaceAccess(delegatedOwner, client, purchaser))
      .rejects.toMatchObject({ code: "WORKSPACE_SUSPENDED", status: 403 });
    expect(await requireEffectiveWhitelabelPurchaser(purchaser)).toMatchObject({
      originalWorkspaceId: original,
    });
  });

  it("fails closed if commercial owner loses their original operational OWNER membership", async () => {
    await db.delete(memberships).where(eq(memberships.workspaceId, original));
    await expect(requireEffectiveWhitelabelPurchaser(purchaser))
      .rejects.toMatchObject({ code: "WHITELABEL_REQUIRED", status: 403 });
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  licenses, memberships, user, whitelabelBrandVersions, whitelabelBrands,
  workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import {
  getBrandState, publishBrand, revertPublishedBrand, saveBrandDraft,
} from "./brand-service";
import { DEFAULT_BRAND_DRAFT } from "./brand-schema";

let purchaser = "";
let original = "";

async function grant(code: string) {
  await db.insert(licenses).values({
    workspaceId: original, purchaserUserId: purchaser, source: "MANUAL",
    externalPurchaseId: randomUUID(), productCode: code, status: "ACTIVE", purchasedAt: new Date(),
  });
}

describe("F12-C purchaser brand lifecycle", () => {
  beforeEach(async () => {
    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser, name: "Brand Purchaser", email: purchaser + "@example.com", emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Purchaser Business" }).returning();
    original = workspace.id;
    await db.insert(memberships).values({ workspaceId: original, userId: purchaser, role: "OWNER" });
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: original, purchaserUserId: purchaser, kind: "PRIMARY",
    });
    await grant("CORE");
    await grant("AGENCY_50");
    await grant("WHITELABEL");
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, original));
    await db.delete(user).where(eq(user.id, purchaser));
  });
  afterAll(async () => closeDatabase());

  it("starts with a stable empty draft and saves with optimistic revision control", async () => {
    expect(await getBrandState(purchaser)).toMatchObject({
      draft: DEFAULT_BRAND_DRAFT, revision: 0, publishedVersion: null, versions: [],
    });
    const saved = await saveBrandDraft(purchaser, 0, {
      ...DEFAULT_BRAND_DRAFT,
      name: "Stratos Assist",
      supportEmail: "support@stratosassist.com",
    });
    expect(saved.revision).toBe(1);
    await expect(saveBrandDraft(purchaser, 0, { ...saved.draft, tagline: "Stale tab" }))
      .rejects.toMatchObject({ code: "BRAND_REVISION_CONFLICT", status: 409 });
  });

  it("publishes immutable versions while later draft edits leave the published snapshot unchanged", async () => {
    const saved = await saveBrandDraft(purchaser, 0, {
      ...DEFAULT_BRAND_DRAFT,
      name: "Stratos Assist",
      supportEmail: "support@stratosassist.com",
    });
    const v1 = await publishBrand(purchaser, saved.revision);
    expect(v1.publishedVersion).toBe(1);
    const edited = await saveBrandDraft(purchaser, saved.revision, {
      ...saved.draft, name: "Stratos Assist Next",
    });
    expect(edited.published?.name).toBe("Stratos Assist");
    const rows = await db.select().from(whitelabelBrandVersions)
      .where(eq(whitelabelBrandVersions.brandId, edited.brandId));
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot).toMatchObject({ name: "Stratos Assist" });
  });

  it("requires a publish-ready name and support contact", async () => {
    const state = await getBrandState(purchaser);
    await expect(publishBrand(purchaser, state.revision))
      .rejects.toMatchObject({ code: "BRAND_NOT_READY", status: 422 });
  });

  it("reverts by creating a new immutable publication instead of rewriting history", async () => {
    let state = await saveBrandDraft(purchaser, 0, {
      ...DEFAULT_BRAND_DRAFT, name: "Brand One", supportEmail: "one@example.com",
    });
    await publishBrand(purchaser, state.revision);
    state = await saveBrandDraft(purchaser, state.revision, {
      ...state.draft, name: "Brand Two",
    });
    await publishBrand(purchaser, state.revision);
    const reverted = await revertPublishedBrand(purchaser, 1);
    expect(reverted.publishedVersion).toBe(3);
    expect(reverted.draft.name).toBe("Brand One");
    expect(reverted.published?.name).toBe("Brand One");
    expect(reverted.versions.map((item) => item.version)).toEqual([3, 2, 1]);
  });

  it("preserves brand data when Whitelabel entitlement is later revoked", async () => {
    const saved = await saveBrandDraft(purchaser, 0, {
      ...DEFAULT_BRAND_DRAFT, name: "Keep Me", supportEmail: "support@example.com",
    });
    await publishBrand(purchaser, saved.revision);
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.productCode, "WHITELABEL"));
    const [row] = await db.select().from(whitelabelBrands)
      .where(eq(whitelabelBrands.purchaserUserId, purchaser));
    expect(row.draft).toMatchObject({ name: "Keep Me" });
  });
});

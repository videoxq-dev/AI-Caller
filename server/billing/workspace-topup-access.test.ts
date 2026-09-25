import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { user, workspaceCommercialOwners, workspaces } from "@/db/schema";
import { createCreditTopupCheckout } from "./checkout";
import { canPurchaseWorkspaceCredits, requireWorkspaceCreditPurchaser } from "./workspace-topup-access";

let agencyId = "";
let clientId = "";
let workspaceId = "";
let originalId = "";

describe("Agency client credit-purchase boundary", () => {
  beforeEach(async () => {
    agencyId = randomUUID();
    clientId = randomUUID();
    await db.insert(user).values([
      { id: agencyId, name: "Agency Purchaser", email: `${agencyId}@example.com`, emailVerified: true },
      { id: clientId, name: "Delegated Client Owner", email: `${clientId}@example.com`, emailVerified: true },
    ]);
    const rows = await db.insert(workspaces).values([
      { name: "Agency Original" }, { name: "Agency Client" },
    ]).returning({ id: workspaces.id });
    [originalId, workspaceId] = rows.map((row) => row.id);
    await db.insert(workspaceCommercialOwners).values([
      { workspaceId: originalId, purchaserUserId: agencyId, kind: "PRIMARY" },
      { workspaceId, purchaserUserId: agencyId, kind: "ADDITIONAL" },
    ]);
  });

  afterEach(async () => {
    for (const id of [workspaceId, originalId]) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    for (const id of [clientId, agencyId]) {
      await db.delete(user).where(eq(user.id, id));
    }
  });
  afterAll(async () => closeDatabase());

  it("permits the Agency purchaser but never grants the delegated client checkout rights", async () => {
    expect(await canPurchaseWorkspaceCredits(agencyId, workspaceId)).toBe(true);
    expect(await canPurchaseWorkspaceCredits(clientId, workspaceId)).toBe(false);
    await expect(requireWorkspaceCreditPurchaser(clientId, workspaceId))
      .rejects.toMatchObject({ code: "AGENCY_CLIENT_TOPUP_DISABLED", status: 403 });
  });

  it("denies client checkout before creating a pending top-up or calling Stripe", async () => {
    await expect(createCreditTopupCheckout({
      workspaceId,
      userId: clientId,
      customerEmail: `${clientId}@example.com`,
      packCode: "CREDITS_10000",
      appBaseUrl: "https://app.example.com",
    })).rejects.toMatchObject({ code: "AGENCY_CLIENT_TOPUP_DISABLED", status: 403 });
  });

  it("rejects attempts to redirect an Agency pool checkout to a different purchaser", async () => {
    await expect(createCreditTopupCheckout({
      workspaceId,
      userId: agencyId,
      customerEmail: `${agencyId}@example.com`,
      packCode: "CREDITS_10000",
      appBaseUrl: "https://app.example.com",
      fundingDestination: "AGENCY_POOL",
      agencyPurchaserUserId: clientId,
    })).rejects.toMatchObject({ code: "AGENCY_POOL_PURCHASER_MISMATCH", status: 403 });
  });
});

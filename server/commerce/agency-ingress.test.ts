import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { commerceEvents, licenses, memberships, user, workspaces } from "@/db/schema";
import { getOwnedWorkspaceCapacity } from "@/server/auth/workspace-repository";
import { resetEnvForTests } from "@/server/env";
import { processCommerceEvent } from "./service";
import type { NormalizedPurchaseEvent } from "./types";

let buyerId = "";
let workspaceId = "";
const eventIds: string[] = [];
const buyerEmail = "agency-ingress-buyer@example.com";

function event(
  type: string,
  receipt: string,
  productId: "agency-ingress-50" | "agency-ingress-100" = "agency-ingress-50",
  externalEventId = randomUUID(),
): NormalizedPurchaseEvent {
  eventIds.push(externalEventId);
  return {
    source: "JVZOO",
    externalEventId,
    externalPurchaseId: receipt,
    eventType: type,
    productId,
    customerEmail: buyerEmail,
    customerName: "Agency Ingress Buyer",
    purchasedAt: new Date(),
    raw: { ingress: true, type, productId },
  };
}

describe("Agency JVZoo ingress", () => {
  beforeEach(async () => {
    vi.stubEnv("JVZOO_AGENCY_50_PRODUCT_IDS", "agency-ingress-50");
    vi.stubEnv("JVZOO_AGENCY_100_PRODUCT_IDS", "agency-ingress-100");
    resetEnvForTests();

    buyerId = randomUUID();
    await db.insert(user).values({
      id: buyerId,
      name: "Agency Ingress Buyer",
      email: buyerEmail,
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Agency Original" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: buyerId, role: "OWNER" });
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: buyerId,
      source: "JVZOO",
      externalPurchaseId: "agency-ingress-core",
      productCode: "CORE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
  });

  afterEach(async () => {
    for (const id of eventIds.splice(0)) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(user).where(eq(user.id, buyerId));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("records a verified Agency sale and exposes capacity through the account entitlement model", async () => {
    const sale = event("SALE", "agency-ingress-sale");
    expect(await processCommerceEvent(sale)).toMatchObject({
      duplicate: false,
      result: {
        ignored: false,
        workspaceId,
        productCode: "AGENCY_50",
        status: "ACTIVE",
      },
    });
    const [stored] = await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, sale.externalEventId));
    expect(stored.status).toBe("PROCESSED");
    expect(await getOwnedWorkspaceCapacity(buyerId)).toMatchObject({
      businessLimit: 51,
      agencyClientLimit: 50,
      agencyClientsAvailable: 50,
    });
  });

  it("keeps duplicate provider event IDs idempotent", async () => {
    const eventId = randomUUID();
    const sale = event("SALE", "agency-ingress-duplicate", "agency-ingress-50", eventId);
    expect((await processCommerceEvent(sale)).duplicate).toBe(false);
    expect(await processCommerceEvent({ ...sale })).toEqual({ duplicate: true });
    expect(await db.select().from(licenses).where(eq(licenses.externalPurchaseId, sale.externalPurchaseId)))
      .toHaveLength(1);
  });

  it("processes a later refund without suspending Core or deleting the original workspace", async () => {
    const receipt = "agency-ingress-refund";
    await processCommerceEvent(event("SALE", receipt, "agency-ingress-100"));
    const refund = event("RFND", receipt, "agency-ingress-100");
    expect(await processCommerceEvent(refund)).toMatchObject({
      duplicate: false,
      result: { productCode: "AGENCY_100", status: "REFUNDED" },
    });
    expect((await getOwnedWorkspaceCapacity(buyerId)).agencyClientLimit).toBeNull();
    expect((await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].status)
      .toBe("ACTIVE");
    const [core] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, "agency-ingress-core"));
    expect(core.status).toBe("ACTIVE");
  });

  it("leaves a premature refund failed and retryable instead of consuming it", async () => {
    const receipt = "agency-ingress-out-of-order";
    const refund = event("RFND", receipt);
    await expect(processCommerceEvent(refund))
      .rejects.toMatchObject({ code: "LICENSE_NOT_FOUND", status: 503 });
    expect((await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, refund.externalEventId)))[0].status).toBe("FAILED");

    await processCommerceEvent(event("SALE", receipt));
    expect((await processCommerceEvent(refund)).duplicate).toBe(false);
    expect((await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, refund.externalEventId)))[0].status).toBe("PROCESSED");
  });
});

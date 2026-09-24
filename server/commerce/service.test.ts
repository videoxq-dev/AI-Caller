import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDatabase } from "@/db";
import { commerceEvents, licenses } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { processCommerceEvent } from "./service";
import type { NormalizedPurchaseEvent } from "./types";

const previousCore = process.env.JVZOO_CORE_PRODUCT_IDS;
const previousUnlimited = process.env.JVZOO_UNLIMITED_PRODUCT_IDS;

function event(productId: string): NormalizedPurchaseEvent {
  const id = randomUUID();
  return {
    source: "JVZOO",
    externalEventId: id,
    externalPurchaseId: id,
    eventType: "SALE",
    productId,
    customerEmail: "unprovisioned-funnel-test@example.com",
    customerName: "Funnel Buyer",
    purchasedAt: new Date(),
    raw: { test: true },
  };
}

describe("funnel purchase ingress", () => {
  beforeEach(() => {
    process.env.JVZOO_CORE_PRODUCT_IDS = "live-core-product";
    process.env.JVZOO_UNLIMITED_PRODUCT_IDS = "configured-but-unready-unlimited";
    resetEnvForTests();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  afterEach(() => {
    if (previousCore === undefined) delete process.env.JVZOO_CORE_PRODUCT_IDS;
    else process.env.JVZOO_CORE_PRODUCT_IDS = previousCore;
    if (previousUnlimited === undefined) delete process.env.JVZOO_UNLIMITED_PRODUCT_IDS;
    else process.env.JVZOO_UNLIMITED_PRODUCT_IDS = previousUnlimited;
    resetEnvForTests();
  });

  it("rejects configured unfinished OTOs before consuming the provider event ID", async () => {
    const purchase = event("configured-but-unready-unlimited");
    await expect(processCommerceEvent(purchase)).rejects.toMatchObject({
      code: "FUNNEL_OFFER_NOT_READY",
      status: 503,
    });

    const stored = await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, purchase.externalEventId));
    expect(stored).toHaveLength(0);
    const assigned = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, purchase.externalPurchaseId));
    expect(assigned).toHaveLength(0);
  });

  it("ignores unknown product IDs without granting them a Core license", async () => {
    const purchase = event("unknown-product");
    const result = await processCommerceEvent(purchase);
    expect(result).toMatchObject({
      duplicate: false,
      result: { ignored: true, reason: "UNMAPPED_PRODUCT" },
    });

    const assigned = await db.select().from(licenses)
      .where(eq(licenses.externalPurchaseId, purchase.externalPurchaseId));
    expect(assigned).toHaveLength(0);
    const [stored] = await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, purchase.externalEventId));
    expect(stored.status).toBe("IGNORED");
  });
});

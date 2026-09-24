import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDatabase } from "@/db";
import { commerceEvents, licenses } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { processCommerceEvent } from "./service";
import type { NormalizedPurchaseEvent } from "./types";

const previousCore = process.env.JVZOO_CORE_PRODUCT_IDS;
const previousUnlimited = process.env.JVZOO_UNLIMITED_PRODUCT_IDS;
const testEventIds: string[] = [];

function event(productId: string): NormalizedPurchaseEvent {
  const id = randomUUID();
  testEventIds.push(id);
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

  afterEach(async () => {
    for (const id of testEventIds) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    testEventIds.length = 0;
    if (previousCore === undefined) delete process.env.JVZOO_CORE_PRODUCT_IDS;
    else process.env.JVZOO_CORE_PRODUCT_IDS = previousCore;
    if (previousUnlimited === undefined) delete process.env.JVZOO_UNLIMITED_PRODUCT_IDS;
    else process.env.JVZOO_UNLIMITED_PRODUCT_IDS = previousUnlimited;
    vi.unstubAllEnvs();
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

  it("retries an event that failed during misconfiguration without granting unintended Core access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.JVZOO_CORE_PRODUCT_IDS = "";
    resetEnvForTests();
    const purchase = event("unmapped-during-misconfiguration");

    await expect(processCommerceEvent(purchase)).rejects.toThrow(
      "JVZOO_CORE_PRODUCT_IDS must be configured in production",
    );
    const [failed] = await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, purchase.externalEventId));
    expect(failed.status).toBe("FAILED");

    process.env.JVZOO_CORE_PRODUCT_IDS = "real-core-only";
    resetEnvForTests();
    expect(await processCommerceEvent(purchase)).toMatchObject({
      duplicate: false,
      result: { ignored: true, reason: "UNMAPPED_PRODUCT" },
    });
    const [retried] = await db.select().from(commerceEvents)
      .where(eq(commerceEvents.externalEventId, purchase.externalEventId));
    expect(retried.status).toBe("IGNORED");
    expect(retried.error).toBeNull();
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

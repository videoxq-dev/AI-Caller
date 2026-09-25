import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  commerceEvents,
  licenses,
  memberships,
  user,
  whitelabelDomains,
  workspaceCommercialOwners,
  workspaces,
} from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { reconcileAgencyReceipt } from "@/server/commerce/agency-lifecycle";
import { processCommerceEvent } from "@/server/commerce/service";
import { reconcileWhitelabelReceipt } from "@/server/commerce/whitelabel-lifecycle";
import type { NormalizedPurchaseEvent } from "@/server/commerce/types";
import { claimWhitelabelDomain } from "./domain-service";
import { syncWhitelabelDomainEntitlementInTx } from "./domain-entitlement-lifecycle";

let purchaser = "";
let original = "";
const eventIds: string[] = [];

function event(
  type: string,
  productId: string,
  receipt: string,
): NormalizedPurchaseEvent {
  const externalEventId = randomUUID();
  eventIds.push(externalEventId);
  return {
    source: "JVZOO",
    externalEventId,
    externalPurchaseId: receipt,
    eventType: type,
    productId,
    customerEmail: purchaser + "@example.com",
    customerName: "Domain Lifecycle Purchaser",
    purchasedAt: new Date(),
    raw: { type, productId, receipt },
  };
}

async function insertLicense(code: "CORE" | "AGENCY_50" | "WHITELABEL", receipt: string) {
  const [license] = await db.insert(licenses).values({
    workspaceId: original,
    purchaserUserId: purchaser,
    source: "JVZOO",
    externalPurchaseId: receipt,
    productCode: code,
    status: "ACTIVE",
    purchasedAt: new Date(),
  }).returning();
  return license;
}

async function readyDomain() {
  const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
  const now = new Date();
  await db.update(whitelabelDomains).set({
    status: "CERT_READY",
    aVerifiedAt: now,
    txtVerifiedAt: now,
    dnsVerifiedAt: now,
    routeId: "wl-" + domain.id.replaceAll("-", ""),
    routeProvisionedAt: now,
    certificateStatus: "READY",
    certificateReadyAt: now,
    certificateExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
  }).where(eq(whitelabelDomains.id, domain.id));
  return domain;
}

async function storedDomain(id: string) {
  const [row] = await db.select().from(whitelabelDomains).where(eq(whitelabelDomains.id, id));
  return row;
}

describe("F12-D7 commerce-to-domain lifecycle integration", () => {
  beforeEach(async () => {
    vi.stubEnv("JVZOO_CORE_PRODUCT_IDS", "core-product");
    vi.stubEnv("JVZOO_AGENCY_50_PRODUCT_IDS", "agency-product");
    vi.stubEnv("JVZOO_WHITELABEL_PRODUCT_IDS", "whitelabel-product");
    vi.stubEnv("WHITELABEL_PUBLIC_IPV4", "203.0.113.25");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "app.aicaller.com");
    resetEnvForTests();

    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser,
      name: "Domain Lifecycle Purchaser",
      email: purchaser + "@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Lifecycle Business" }).returning();
    original = workspace.id;
    await db.insert(memberships).values({ workspaceId: original, userId: purchaser, role: "OWNER" });
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: original,
      purchaserUserId: purchaser,
      kind: "PRIMARY",
    });
    await insertLicense("CORE", "core-receipt");
    await insertLicense("AGENCY_50", "agency-receipt");
    await insertLicense("WHITELABEL", "whitelabel-receipt");
  });

  afterEach(async () => {
    for (const id of eventIds.splice(0)) {
      await db.delete(commerceEvents).where(eq(commerceEvents.externalEventId, id));
    }
    await db.delete(workspaces).where(eq(workspaces.id, original));
    await db.delete(user).where(eq(user.id, purchaser));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => closeDatabase());

  it("revokes and safely restores the domain through the Agency recurring lifecycle", async () => {
    const domain = await readyDomain();

    await reconcileAgencyReceipt(event("CANCEL-REBILL", "agency-product", "agency-receipt"));
    expect(await storedDomain(domain.id)).toMatchObject({
      status: "REVOKED",
      lastErrorCode: "WHITELABEL_ENTITLEMENT_REVOKED",
    });

    await reconcileAgencyReceipt(event("UNCANCEL-REBILL", "agency-product", "agency-receipt"));
    expect(await storedDomain(domain.id)).toMatchObject({
      status: "AWAITING_DNS",
      dnsVerifiedAt: null,
      certificateStatus: "NOT_REQUESTED",
      lastErrorCode: "WHITELABEL_ENTITLEMENT_RESTORED",
    });
  });

  it("revokes and safely restores the domain through the Whitelabel recurring lifecycle", async () => {
    const domain = await readyDomain();

    await reconcileWhitelabelReceipt(event("CANCEL-REBILL", "whitelabel-product", "whitelabel-receipt"));
    expect((await storedDomain(domain.id)).status).toBe("REVOKED");

    await reconcileWhitelabelReceipt(event("UNCANCEL-REBILL", "whitelabel-product", "whitelabel-receipt"));
    expect(await storedDomain(domain.id)).toMatchObject({
      status: "AWAITING_DNS",
      dnsVerifiedAt: null,
      certificateStatus: "NOT_REQUESTED",
    });
  });

  it("revokes and safely restores the domain through the Core public commerce lifecycle", async () => {
    const domain = await readyDomain();

    const cancelled = await processCommerceEvent(event("CANCEL-REBILL", "core-product", "core-receipt"));
    expect(cancelled.duplicate).toBe(false);
    expect((await storedDomain(domain.id)).status).toBe("REVOKED");

    const restored = await processCommerceEvent(event("UNCANCEL-REBILL", "core-product", "core-receipt"));
    expect(restored.duplicate).toBe(false);
    expect(await storedDomain(domain.id)).toMatchObject({
      status: "AWAITING_DNS",
      dnsVerifiedAt: null,
      certificateStatus: "NOT_REQUESTED",
    });
  });

  it("serializes concurrent prerequisite changes and converges to the final commercial state", async () => {
    const domain = await readyDomain();
    const [agency] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, "agency-receipt"));
    const [whitelabel] = await db.select().from(licenses).where(eq(licenses.externalPurchaseId, "whitelabel-receipt"));

    await Promise.all([
      db.transaction(async (tx) => {
        await tx.update(licenses).set({ status: "CANCELLED" }).where(eq(licenses.id, agency.id));
        await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
      }),
      db.transaction(async (tx) => {
        await tx.update(licenses).set({ status: "CANCELLED" }).where(eq(licenses.id, whitelabel.id));
        await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
      }),
    ]);
    expect((await storedDomain(domain.id)).status).toBe("REVOKED");

    await Promise.all([
      db.transaction(async (tx) => {
        await tx.update(licenses).set({ status: "ACTIVE" }).where(eq(licenses.id, agency.id));
        await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
      }),
      db.transaction(async (tx) => {
        await tx.update(licenses).set({ status: "ACTIVE" }).where(eq(licenses.id, whitelabel.id));
        await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
      }),
    ]);
    expect((await storedDomain(domain.id)).status).toBe("AWAITING_DNS");
  });
});

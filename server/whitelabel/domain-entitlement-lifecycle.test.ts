import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  licenses, memberships, user, whitelabelDomains, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { claimWhitelabelDomain } from "./domain-service";
import { syncWhitelabelDomainEntitlementInTx } from "./domain-entitlement-lifecycle";

let purchaser = "";
let original = "";

async function grant(code: string, source: "MANUAL" | "JVZOO" = "MANUAL") {
  const [license] = await db.insert(licenses).values({
    workspaceId: original,
    purchaserUserId: purchaser,
    source,
    externalPurchaseId: randomUUID(),
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

describe("F12-D7 custom-domain commercial lifecycle", () => {
  beforeEach(async () => {
    vi.stubEnv("WHITELABEL_PUBLIC_IPV4", "203.0.113.25");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "app.aicaller.com");
    resetEnvForTests();

    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser,
      name: "Lifecycle Purchaser",
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
    await grant("CORE");
    await grant("AGENCY_50");
    await grant("WHITELABEL");
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, original));
    await db.delete(user).where(eq(user.id, purchaser));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => closeDatabase());

  it.each(["CORE", "AGENCY_50", "WHITELABEL"] as const)(
    "marks the public domain REVOKED when the %s prerequisite is lost",
    async (code) => {
      const domain = await readyDomain();
      await db.transaction(async (tx) => {
        await tx.update(licenses).set({ status: "REFUNDED" })
          .where(eq(licenses.productCode, code));
        await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
      });

      const [stored] = await db.select().from(whitelabelDomains)
        .where(eq(whitelabelDomains.id, domain.id));
      expect(stored).toMatchObject({
        status: "REVOKED",
        routeId: "wl-" + domain.id.replaceAll("-", ""),
        lastErrorCode: "WHITELABEL_ENTITLEMENT_REVOKED",
      });
    },
  );

  it("does not revoke when another active receipt still satisfies the same prerequisite", async () => {
    const domain = await readyDomain();
    const firstAgency = (await db.select().from(licenses)
      .where(eq(licenses.productCode, "AGENCY_50")))[0];
    await grant("AGENCY_100");
    await db.transaction(async (tx) => {
      await tx.update(licenses).set({ status: "REFUNDED" })
        .where(eq(licenses.id, firstAgency.id));
      await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
    });
    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored.status).toBe("CERT_READY");
  });

  it("restores a revoked claim to AWAITING_DNS and clears stale verification/certificate state", async () => {
    const domain = await readyDomain();
    const [wl] = await db.select().from(licenses).where(eq(licenses.productCode, "WHITELABEL")).limit(1);

    await db.transaction(async (tx) => {
      await tx.update(licenses).set({ status: "CANCELLED" }).where(eq(licenses.id, wl.id));
      await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
    });
    await db.transaction(async (tx) => {
      await tx.update(licenses).set({ status: "ACTIVE" }).where(eq(licenses.id, wl.id));
      await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
    });

    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored).toMatchObject({
      status: "AWAITING_DNS",
      aVerifiedAt: null,
      txtVerifiedAt: null,
      dnsVerifiedAt: null,
      certificateStatus: "NOT_REQUESTED",
      certificateReadyAt: null,
      certificateExpiresAt: null,
      routeId: "wl-" + domain.id.replaceAll("-", ""),
      lastErrorCode: "WHITELABEL_ENTITLEMENT_RESTORED",
    });
  });

  it("leaves an already-disabled historical claim disabled", async () => {
    const domain = await readyDomain();
    await db.update(whitelabelDomains).set({ status: "DISABLED", disabledAt: new Date() })
      .where(eq(whitelabelDomains.id, domain.id));
    await db.transaction(async (tx) => {
      await tx.update(licenses).set({ status: "REFUNDED" })
        .where(eq(licenses.productCode, "WHITELABEL"));
      await syncWhitelabelDomainEntitlementInTx(tx, purchaser);
    });
    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored.status).toBe("DISABLED");
  });

  it("is a no-op when the purchaser has no domain claim", async () => {
    await expect(db.transaction((tx) => syncWhitelabelDomainEntitlementInTx(tx, purchaser)))
      .resolves.toMatchObject({ changed: false, effective: true });
  });
});

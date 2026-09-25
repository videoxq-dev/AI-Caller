import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  licenses, memberships, user, whitelabelDomains, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { claimWhitelabelDomain } from "./domain-service";
import { resolveWhitelabelHoldingHost } from "./domain-host-guard";

let purchaser = "";
let original = "";

async function grant(code: string) {
  await db.insert(licenses).values({
    workspaceId: original,
    purchaserUserId: purchaser,
    source: "MANUAL",
    externalPurchaseId: randomUUID(),
    productCode: code,
    status: "ACTIVE",
    purchasedAt: new Date(),
  });
}

async function routed(status: "CERT_PENDING" | "CERT_READY" | "ACTIVE" = "CERT_PENDING") {
  const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
  await db.update(whitelabelDomains).set({
    status,
    dnsVerifiedAt: new Date(),
    routeId: "wl-" + domain.id.replaceAll("-", ""),
    routeProvisionedAt: new Date(),
    certificateStatus: status === "CERT_PENDING" ? "PENDING" : "READY",
    certificateReadyAt: status === "CERT_PENDING" ? null : new Date(),
  }).where(eq(whitelabelDomains.id, domain.id));
  return domain;
}

describe("F12-D6 Whitelabel holding-host guard", () => {
  beforeEach(async () => {
    vi.stubEnv("WHITELABEL_PUBLIC_IPV4", "203.0.113.25");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "app.aicaller.com");
    resetEnvForTests();

    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser,
      name: "Host Guard Purchaser",
      email: purchaser + "@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Host Guard Business" }).returning();
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

  it.each(["CERT_PENDING", "CERT_READY", "ACTIVE"] as const)(
    "accepts a routed %s hostname only while its purchaser remains entitled",
    async (status) => {
      await routed(status);
      const resolved = await resolveWhitelabelHoldingHost("clients.stratosassist.com");
      expect(resolved).toMatchObject({ hostname: "clients.stratosassist.com", purchaserUserId: purchaser, status });
    },
  );

  it("normalizes a Host header containing the standard HTTPS port", async () => {
    await routed();
    const resolved = await resolveWhitelabelHoldingHost("Clients.StratosAssist.COM:443");
    expect(resolved?.hostname).toBe("clients.stratosassist.com");
  });

  it("rejects an unknown hostname", async () => {
    await routed();
    await expect(resolveWhitelabelHoldingHost("unknown.stratosassist.com")).resolves.toBeNull();
  });

  it.each(["AWAITING_DNS", "VERIFIED", "DNS_MISMATCH", "REVOKED", "DISABLING", "DISABLED"] as const)(
    "rejects a domain in %s even if a stale edge route still points at the holding endpoint",
    async (status) => {
      const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
      await db.update(whitelabelDomains).set({
        status,
        routeId: "wl-" + domain.id.replaceAll("-", ""),
        routeProvisionedAt: new Date(),
      }).where(eq(whitelabelDomains.id, domain.id));
      await expect(resolveWhitelabelHoldingHost("clients.stratosassist.com")).resolves.toBeNull();
    },
  );

  it("fails closed immediately when Whitelabel entitlement is refunded even before route cleanup", async () => {
    await routed("CERT_READY");
    await db.update(licenses).set({ status: "REFUNDED" })
      .where(and(eq(licenses.productCode, "WHITELABEL"), eq(licenses.purchaserUserId, purchaser)));
    await expect(resolveWhitelabelHoldingHost("clients.stratosassist.com")).resolves.toBeNull();
  });

  it("fails closed when the Agency prerequisite is lost", async () => {
    await routed("CERT_READY");
    await db.update(licenses).set({ status: "CANCELLED" })
      .where(and(eq(licenses.productCode, "AGENCY_50"), eq(licenses.purchaserUserId, purchaser)));
    await expect(resolveWhitelabelHoldingHost("clients.stratosassist.com")).resolves.toBeNull();
  });

  it("rejects malformed or canonical host headers without throwing", async () => {
    await routed();
    await expect(resolveWhitelabelHoldingHost("127.0.0.1:443")).resolves.toBeNull();
    await expect(resolveWhitelabelHoldingHost("app.aicaller.com")).resolves.toBeNull();
    await expect(resolveWhitelabelHoldingHost("")).resolves.toBeNull();
  });
});

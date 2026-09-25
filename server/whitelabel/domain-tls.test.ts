import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  licenses, memberships, user, whitelabelDomains, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { claimWhitelabelDomain } from "./domain-service";
import {
  processPendingWhitelabelTlsChecks,
  verifyWhitelabelDomainTls,
  type WhitelabelTlsProbe,
} from "./domain-tls";

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

async function pendingDomain() {
  const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
  const now = new Date();
  await db.update(whitelabelDomains).set({
    status: "CERT_PENDING",
    certificateStatus: "PENDING",
    dnsVerifiedAt: now,
    routeId: "wl-" + domain.id.replace(/-/g, ""),
    routeProvisionedAt: now,
    lastCheckedAt: new Date(Date.now() - 120_000),
  }).where(eq(whitelabelDomains.id, domain.id));
  return domain;
}

describe("F12-D5 public TLS readiness verification", () => {
  beforeEach(async () => {
    vi.stubEnv("WHITELABEL_PUBLIC_IPV4", "203.0.113.25");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "app.aicaller.com");
    resetEnvForTests();

    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser,
      name: "TLS Purchaser",
      email: purchaser + "@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "TLS Business" }).returning();
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

  it("marks CERT_READY only after trusted HTTPS reaches AI Caller on the same hostname", async () => {
    const domain = await pendingDomain();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const probe: WhitelabelTlsProbe = vi.fn(async () => ({
      statusCode: 200,
      returnedHost: domain.hostname,
      certificateExpiresAt: expiresAt,
    }));

    const result = await verifyWhitelabelDomainTls(domain.id, probe);
    expect(result).toMatchObject({
      status: "CERT_READY",
      certificateStatus: "READY",
      lastErrorCode: null,
    });
    expect(result.certificateReadyAt).toBeInstanceOf(Date);
    expect(result.certificateExpiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(probe).toHaveBeenCalledWith(domain.hostname);
  });

  it("keeps the lifecycle pending and records a failed certificate check when the routed Host is wrong", async () => {
    const domain = await pendingDomain();
    const probe: WhitelabelTlsProbe = vi.fn(async () => ({
      statusCode: 200,
      returnedHost: "another.example.com",
      certificateExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }));

    const result = await verifyWhitelabelDomainTls(domain.id, probe);
    expect(result).toMatchObject({
      status: "CERT_PENDING",
      certificateStatus: "FAILED",
      lastErrorCode: "TLS_HOST_MISMATCH",
    });
    expect(result.certificateReadyAt).toBeNull();
  });

  it("records TLS connection failures without advancing or deleting the route", async () => {
    const domain = await pendingDomain();
    const probe: WhitelabelTlsProbe = vi.fn(async () => {
      throw new Error("certificate has expired");
    });

    const result = await verifyWhitelabelDomainTls(domain.id, probe);
    expect(result).toMatchObject({
      status: "CERT_PENDING",
      certificateStatus: "FAILED",
      routeId: "wl-" + domain.id.replace(/-/g, ""),
      lastErrorCode: "TLS_PROBE_FAILED",
    });
  });

  it("refuses TLS readiness before routing has advanced the domain to CERT_PENDING", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    await db.update(whitelabelDomains).set({
      status: "VERIFIED",
      dnsVerifiedAt: new Date(),
    }).where(eq(whitelabelDomains.id, domain.id));

    await expect(verifyWhitelabelDomainTls(domain.id, vi.fn()))
      .rejects.toMatchObject({ code: "WHITELABEL_DOMAIN_TLS_NOT_READY", status: 409 });
  });

  it("processes only due CERT_PENDING domains in the background batch", async () => {
    const domain = await pendingDomain();
    const other = await claimWhitelabelDomain(purchaser, "portal.stratosassist.com")
      .catch(() => null);
    expect(other).toBeNull();

    const probe: WhitelabelTlsProbe = vi.fn(async (hostname) => ({
      statusCode: 200,
      returnedHost: hostname,
      certificateExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }));
    const result = await processPendingWhitelabelTlsChecks(20, probe);
    expect(result.checked).toBe(1);
    expect(result.ready).toBe(1);
    expect(result.failed).toBe(0);

    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored.status).toBe("CERT_READY");
  });
});

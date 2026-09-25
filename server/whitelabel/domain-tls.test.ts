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
  buildWhitelabelTlsProbeTarget,
  reconcileWhitelabelDomainTls,
  reconcilePendingWhitelabelDomainCertificates,
  type WhitelabelTlsProber,
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

async function certPending() {
  const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
  const now = new Date();
  await db.update(whitelabelDomains).set({
    status: "CERT_PENDING",
    aVerifiedAt: now,
    txtVerifiedAt: now,
    dnsVerifiedAt: now,
    routeId: "wl-" + domain.id.replaceAll("-", ""),
    routeProvisionedAt: now,
    certificateStatus: "PENDING",
  }).where(eq(whitelabelDomains.id, domain.id));
  return domain;
}

describe("F12-D5 public TLS readiness", () => {
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

  it("pins TLS network traffic to the configured AI Caller edge while preserving customer SNI/Host", () => {
    expect(buildWhitelabelTlsProbeTarget("clients.stratosassist.com")).toEqual({
      connectHostname: "203.0.113.25",
      servername: "clients.stratosassist.com",
      hostHeader: "clients.stratosassist.com",
    });
  });

  it("promotes CERT_PENDING only after a trusted HTTPS probe succeeds", async () => {
    const domain = await certPending();
    const expiresAt = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000);
    const prober: WhitelabelTlsProber = vi.fn(async () => ({
      ok: true as const,
      statusCode: 200,
      expiresAt,
    }));

    const result = await reconcileWhitelabelDomainTls(domain.id, prober);
    expect(result).toMatchObject({
      status: "CERT_READY",
      certificateStatus: "READY",
      certificateExpiresAt: expiresAt,
      lastErrorCode: null,
    });
    expect(result.certificateReadyAt).toBeInstanceOf(Date);
    expect(prober).toHaveBeenCalledWith("clients.stratosassist.com");
  });

  it("keeps a pending certificate pending when public TLS is not ready yet", async () => {
    const domain = await certPending();
    const prober: WhitelabelTlsProber = vi.fn(async () => ({
      ok: false as const,
      code: "TLS_CERT_NOT_READY",
      message: "The certificate is not trusted for this hostname yet.",
    }));

    const result = await reconcileWhitelabelDomainTls(domain.id, prober);
    expect(result).toMatchObject({
      status: "CERT_PENDING",
      certificateStatus: "PENDING",
      certificateReadyAt: null,
      lastErrorCode: "TLS_CERT_NOT_READY",
    });
  });

  it.each(["CERT_READY", "ACTIVE"] as const)(
    "refreshes certificate metadata without moving %s backward",
    async (status) => {
      const domain = await certPending();
      const previousReadyAt = new Date(Date.now() - 60_000);
      await db.update(whitelabelDomains).set({
        status,
        certificateStatus: "READY",
        certificateReadyAt: previousReadyAt,
        certificateExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      }).where(eq(whitelabelDomains.id, domain.id));

      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const result = await reconcileWhitelabelDomainTls(domain.id, async () => ({
        ok: true,
        statusCode: 200,
        expiresAt,
      }));
      expect(result.status).toBe(status);
      expect(result.certificateStatus).toBe("READY");
      expect(result.certificateReadyAt?.getTime()).toBe(previousReadyAt.getTime());
      expect(result.certificateExpiresAt?.getTime()).toBe(expiresAt.getTime());
    },
  );

  it("does not downgrade an already-ready domain on a transient public probe failure", async () => {
    const domain = await certPending();
    await db.update(whitelabelDomains).set({
      status: "CERT_READY",
      certificateStatus: "READY",
      certificateReadyAt: new Date(),
      certificateExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
    }).where(eq(whitelabelDomains.id, domain.id));

    const result = await reconcileWhitelabelDomainTls(domain.id, async () => ({
      ok: false,
      code: "TLS_PROBE_FAILED",
      message: "Temporary connection failure.",
    }));
    expect(result.status).toBe("CERT_READY");
    expect(result.certificateStatus).toBe("READY");
    expect(result.lastErrorCode).toBe("TLS_PROBE_FAILED");
  });

  it("does not resurrect a lifecycle that changes while the TLS probe is in flight", async () => {
    const domain = await certPending();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prober: WhitelabelTlsProber = vi.fn(async () => {
      await gate;
      return {
        ok: true as const,
        statusCode: 200,
        expiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      };
    });

    const pending = reconcileWhitelabelDomainTls(domain.id, prober);
    await db.update(whitelabelDomains).set({ status: "REVOKED" })
      .where(eq(whitelabelDomains.id, domain.id));
    release();

    await expect(pending)
      .rejects.toMatchObject({ code: "WHITELABEL_DOMAIN_TLS_STATE_CHANGED", status: 409 });
    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored.status).toBe("REVOKED");
  });

  it("reconciles pending certificates in bounded batches", async () => {
    const domain = await certPending();
    const result = await reconcilePendingWhitelabelDomainCertificates(10, async () => ({
      ok: true,
      statusCode: 200,
      expiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
    }));
    expect(result).toMatchObject({ checked: 1, ready: 1, pending: 0, failed: 0 });
    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored.status).toBe("CERT_READY");
  });
});

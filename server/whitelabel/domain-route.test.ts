import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  licenses, memberships, user, whitelabelDomains, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { claimWhitelabelDomain } from "./domain-service";
import {
  reconcileWhitelabelDomainRoute,
  recoverWhitelabelDomainRoutes,
  renderTraefikDomainRoute,
  routeFilePathForDomain,
} from "./domain-route";

let purchaser = "";
let original = "";
let routeDir = "";

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

async function verifiedDomain() {
  const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
  const now = new Date();
  await db.update(whitelabelDomains).set({
    status: "VERIFIED",
    aVerifiedAt: now,
    txtVerifiedAt: now,
    dnsVerifiedAt: now,
  }).where(eq(whitelabelDomains.id, domain.id));
  return domain;
}

describe("F12-D3 Traefik route reconciliation", () => {
  beforeEach(async () => {
    routeDir = await mkdtemp(path.join(tmpdir(), "aicaller-traefik-"));
    vi.stubEnv("WHITELABEL_PUBLIC_IPV4", "203.0.113.25");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "app.aicaller.com");
    vi.stubEnv("WHITELABEL_DOMAIN_ROUTE_ENABLED", "true");
    vi.stubEnv("WHITELABEL_TRAEFIK_DYNAMIC_DIR", routeDir);
    vi.stubEnv("WHITELABEL_TRAEFIK_ENTRYPOINT", "websecure");
    vi.stubEnv("WHITELABEL_TRAEFIK_CERT_RESOLVER", "letsencrypt");
    vi.stubEnv("WHITELABEL_TRAEFIK_SERVICE_URL", "http://aicaller-web:8080");
    resetEnvForTests();

    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser,
      name: "Route Purchaser",
      email: purchaser + "@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Route Business" }).returning();
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
    await rm(routeDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => closeDatabase());

  it("renders a constrained router/service definition for the verified hostname", () => {
    const yaml = renderTraefikDomainRoute({
      routeId: "wl-11111111111141118111111111111111",
      hostname: "clients.stratosassist.com",
      entryPoint: "websecure",
      certResolver: "letsencrypt",
      serviceUrl: "http://aicaller-web:8080",
    });
    expect(yaml).toContain('rule: "Host(`clients.stratosassist.com`)"');
    expect(yaml).toContain("certResolver: letsencrypt");
    expect(yaml).toContain('url: "http://aicaller-web:8080"');
    expect(yaml).toContain("passHostHeader: true");
    expect(yaml).toContain("middlewares:");
    expect(yaml).toContain("replacePath:");
    expect(yaml).toContain("path: /api/whitelabel/domain-pending");
    expect(yaml).toContain(`- ${"wl-11111111111141118111111111111111"}-holding`);
    expect(yaml).toContain("replacePath:");
    expect(yaml).toContain("path: /api/whitelabel/domain-pending");
  });

  it("materializes a verified domain atomically and advances it to CERT_PENDING", async () => {
    const domain = await verifiedDomain();
    const result = await reconcileWhitelabelDomainRoute(domain.id);
    expect(result).toMatchObject({
      status: "CERT_PENDING",
      certificateStatus: "PENDING",
    });
    expect(result.routeId).toMatch(/^wl-[0-9a-f]+$/);
    expect(result.routeProvisionedAt).toBeInstanceOf(Date);

    const file = routeFilePathForDomain(result.id, routeDir);
    const yaml = await readFile(file, "utf8");
    expect(yaml).toContain("clients.stratosassist.com");
    expect(yaml).toContain("websecure");
    expect(yaml).toContain("letsencrypt");
    await expect(access(file + ".tmp")).rejects.toThrow();
  });

  it("is idempotent for CERT_PENDING and preserves the progressed lifecycle", async () => {
    const domain = await verifiedDomain();
    const first = await reconcileWhitelabelDomainRoute(domain.id);
    const firstYaml = await readFile(routeFilePathForDomain(domain.id, routeDir), "utf8");
    const second = await reconcileWhitelabelDomainRoute(domain.id);
    const secondYaml = await readFile(routeFilePathForDomain(domain.id, routeDir), "utf8");
    expect(second.status).toBe("CERT_PENDING");
    expect(second.routeId).toBe(first.routeId);
    expect(secondYaml).toBe(firstYaml);
  });

  it("recreates a missing route file for an already progressed domain after a redeploy", async () => {
    const domain = await verifiedDomain();
    const first = await reconcileWhitelabelDomainRoute(domain.id);
    const file = routeFilePathForDomain(domain.id, routeDir);
    await unlink(file);
    await db.update(whitelabelDomains).set({
      status: "CERT_READY",
      certificateStatus: "READY",
      certificateReadyAt: new Date(),
    }).where(eq(whitelabelDomains.id, domain.id));

    const recovery = await recoverWhitelabelDomainRoutes(20);
    expect(recovery.materialized).toBeGreaterThanOrEqual(1);
    await expect(access(file)).resolves.toBeUndefined();
    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored.status).toBe("CERT_READY");
    expect(stored.certificateStatus).toBe("READY");
    expect(stored.routeId).toBe(first.routeId);
  });

  it.each(["DNS_MISMATCH", "REVOKED", "DISABLING", "DISABLED"] as const)(
    "removes the route for %s rather than leaving a stale public router",
    async (status) => {
      const domain = await verifiedDomain();
      await reconcileWhitelabelDomainRoute(domain.id);
      const file = routeFilePathForDomain(domain.id, routeDir);
      await db.update(whitelabelDomains).set({
        status,
        disabledAt: status === "DISABLED" ? new Date() : null,
      }).where(eq(whitelabelDomains.id, domain.id));

      const result = await reconcileWhitelabelDomainRoute(domain.id);
      expect(result.status).toBe(status);
      await expect(access(file)).rejects.toThrow();
      expect(result.routeProvisionedAt).toBeNull();
    },
  );

  it("resets prior certificate readiness when a removed route is re-provisioned", async () => {
    const domain = await verifiedDomain();
    await reconcileWhitelabelDomainRoute(domain.id);
    const oldReady = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.update(whitelabelDomains).set({
      status: "DNS_MISMATCH",
      certificateStatus: "READY",
      certificateReadyAt: new Date(),
      certificateExpiresAt: oldReady,
    }).where(eq(whitelabelDomains.id, domain.id));
    await reconcileWhitelabelDomainRoute(domain.id);

    await db.update(whitelabelDomains).set({
      status: "VERIFIED",
      dnsVerifiedAt: new Date(),
    }).where(eq(whitelabelDomains.id, domain.id));
    const reprovisioned = await reconcileWhitelabelDomainRoute(domain.id);

    expect(reprovisioned).toMatchObject({
      status: "CERT_PENDING",
      certificateStatus: "PENDING",
      certificateReadyAt: null,
      certificateExpiresAt: null,
    });
  });

  it("does not materialize a route before DNS verification is complete", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    await expect(reconcileWhitelabelDomainRoute(domain.id))
      .rejects.toMatchObject({ code: "WHITELABEL_DOMAIN_ROUTE_NOT_READY", status: 409 });
    await expect(access(routeFilePathForDomain(domain.id, routeDir))).rejects.toThrow();
  });

  it("becomes a safe no-op when route reconciliation is disabled", async () => {
    const domain = await verifiedDomain();
    vi.stubEnv("WHITELABEL_DOMAIN_ROUTE_ENABLED", "false");
    resetEnvForTests();
    const result = await reconcileWhitelabelDomainRoute(domain.id);
    expect(result.status).toBe("VERIFIED");
    await expect(access(routeFilePathForDomain(domain.id, routeDir))).rejects.toThrow();
  });
});

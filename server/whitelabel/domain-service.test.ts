import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  licenses, memberships, user, whitelabelDomains, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import {
  claimWhitelabelDomain,
  disconnectWhitelabelDomain,
  getWhitelabelDomainState,
  rotateWhitelabelDomainVerification,
} from "./domain-service";

let purchaser = "";
let original = "";
const otherUsers: string[] = [];

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

describe("F12-D purchaser custom-domain registry", () => {
  beforeEach(async () => {
    vi.stubEnv("WHITELABEL_PUBLIC_IPV4", "203.0.113.25");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "app.aicaller.com");
    resetEnvForTests();
    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser,
      name: "Domain Purchaser",
      email: purchaser + "@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "Purchaser Business" }).returning();
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
    for (const id of otherUsers.splice(0)) await db.delete(user).where(eq(user.id, id));
    await db.delete(workspaces).where(eq(workspaces.id, original));
    await db.delete(user).where(eq(user.id, purchaser));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });
  afterAll(async () => closeDatabase());

  it("reserves one normalized hostname for the effective Whitelabel purchaser", async () => {
    const state = await claimWhitelabelDomain(purchaser, "HTTPS://Clients.StratosAssist.COM/");
    expect(state).toMatchObject({
      hostname: "clients.stratosassist.com",
      status: "AWAITING_DNS",
      dns: {
        ipv4: "203.0.113.25",
        verificationRecordName: "_ai-caller-verify.clients.stratosassist.com",
      },
    });
    expect(state.dns.verificationRecordValue).toMatch(/^aicaller-verification=/);
    const reloaded = await getWhitelabelDomainState(purchaser);
    expect(reloaded?.dns.verificationRecordValue).toBe(state.dns.verificationRecordValue);
  });

  it("does not allow a second active hostname for the same brand", async () => {
    await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    await expect(claimWhitelabelDomain(purchaser, "portal.stratosassist.com"))
      .rejects.toMatchObject({ code: "WHITELABEL_DOMAIN_ALREADY_CONFIGURED", status: 409 });
  });

  it("enforces global hostname uniqueness across purchasers", async () => {
    await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const other = randomUUID();
    otherUsers.push(other);
    await db.insert(user).values({ id: other, name: "Other", email: other + "@example.com", emailVerified: true });
    const [workspace] = await db.insert(workspaces).values({ name: "Other Business" }).returning();
    await db.insert(memberships).values({ workspaceId: workspace.id, userId: other, role: "OWNER" });
    await db.insert(workspaceCommercialOwners).values({ workspaceId: workspace.id, purchaserUserId: other, kind: "PRIMARY" });
    for (const code of ["CORE", "AGENCY_50", "WHITELABEL"]) {
      await db.insert(licenses).values({
        workspaceId: workspace.id, purchaserUserId: other, source: "MANUAL",
        externalPurchaseId: randomUUID(), productCode: code, status: "ACTIVE", purchasedAt: new Date(),
      });
    }
    await expect(claimWhitelabelDomain(other, "clients.stratosassist.com"))
      .rejects.toMatchObject({ code: "WHITELABEL_DOMAIN_UNAVAILABLE", status: 409 });
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
  });

  it("rotates DNS proof without changing the reserved hostname", async () => {
    const first = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const next = await rotateWhitelabelDomainVerification(purchaser);
    expect(next.hostname).toBe(first.hostname);
    expect(next.dns.verificationRecordValue).not.toBe(first.dns.verificationRecordValue);
    expect(next.status).toBe("AWAITING_DNS");
  });

  it("preserves the disabled claim for audit but permits the purchaser to connect another domain", async () => {
    const first = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const disabled = await disconnectWhitelabelDomain(purchaser);
    expect(disabled).toMatchObject({ id: first.id, status: "DISABLED" });
    const next = await claimWhitelabelDomain(purchaser, "portal.stratosassist.com");
    expect(next.hostname).toBe("portal.stratosassist.com");
    expect(next.id).not.toBe(first.id);
  });

  it("requires renewed DNS proof after Whitelabel reinstatement", async () => {
    const first = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    await db.update(whitelabelDomains).set({
      status: "REVOKED",
      dnsVerifiedAt: new Date(),
      routeId: "wl-" + first.id.replaceAll("-", ""),
      routeProvisionedAt: new Date(),
      certificateStatus: "READY",
      certificateReadyAt: new Date(),
      certificateExpiresAt: new Date(Date.now() + 30 * 86400_000),
    }).where(eq(whitelabelDomains.id, first.id));

    const restarted = await rotateWhitelabelDomainVerification(purchaser);
    expect(restarted).toMatchObject({
      id: first.id, hostname: first.hostname, status: "AWAITING_DNS",
      certificateStatus: "NOT_REQUESTED",
      dnsVerifiedAt: null, certificateReadyAt: null, certificateExpiresAt: null,
    });
    expect(restarted.dns.verificationRecordValue).not.toBe(first.dns.verificationRecordValue);
    // Retain route identity until the edge worker physically removes its
    // prior file, including if proof rotation races route reconciliation.
    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, first.id));
    expect(stored.routeId).toBeTruthy();
  });

  it("denies domain administration after Whitelabel entitlement is revoked without deleting the claim", async () => {
    await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    await db.update(licenses).set({ status: "REFUNDED" })
      .where(eq(licenses.productCode, "WHITELABEL"));
    await expect(getWhitelabelDomainState(purchaser))
      .rejects.toMatchObject({ code: "WHITELABEL_REQUIRED", status: 403 });
    expect(await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.purchaserUserId, purchaser))).toHaveLength(1);
  });
});

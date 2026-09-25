import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains } from "@/db/schema";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import {
  createSecretBox,
  type EncryptedSecretEnvelope,
} from "@/server/security/secrets";
import { ensureBrandForPurchaser } from "./brand-service";
import { normalizeWhitelabelHostname } from "./domain-hostname";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function tokenBox() {
  return createSecretBox(getEnv().INTEGRATION_ENCRYPTION_KEY);
}

function encryptVerificationToken(token: string) {
  return tokenBox().encrypt({ token }) as unknown as Record<string, unknown>;
}

function decryptVerificationToken(value: Record<string, unknown>) {
  const result = tokenBox().decrypt<{ token: string }>(value as EncryptedSecretEnvelope);
  return result.token;
}

function infrastructure(requirePublicIp = false) {
  const env = getEnv();
  const ipv4 = env.WHITELABEL_PUBLIC_IPV4?.trim();
  if (ipv4 && isIP(ipv4) !== 4) {
    throw new AppError(
      "WHITELABEL_DOMAIN_INFRASTRUCTURE_NOT_CONFIGURED",
      "The configured custom-domain IPv4 address is invalid.",
      503,
    );
  }
  if (requirePublicIp && !ipv4) {
    throw new AppError(
      "WHITELABEL_DOMAIN_INFRASTRUCTURE_NOT_CONFIGURED",
      "Custom domains are not configured on this AI Caller server yet.",
      503,
    );
  }
  const ipv6 = env.WHITELABEL_PUBLIC_IPV6?.trim() || null;
  if (ipv6 && isIP(ipv6) !== 6) {
    throw new AppError(
      "WHITELABEL_DOMAIN_INFRASTRUCTURE_NOT_CONFIGURED",
      "The configured custom-domain IPv6 address is invalid.",
      503,
    );
  }
  const authHost = (() => {
    try { return new URL(env.BETTER_AUTH_URL).hostname; } catch { return ""; }
  })();
  const reservedHosts = [
    env.WHITELABEL_CANONICAL_HOST ?? "",
    authHost,
    ...env.WHITELABEL_RESERVED_HOSTS.split(","),
  ].filter(Boolean);
  return { ipv4, ipv6, reservedHosts };
}

function newVerificationToken() {
  return randomBytes(24).toString("base64url");
}

function toState(row: typeof whitelabelDomains.$inferSelect) {
  const infra = infrastructure();
  const token = decryptVerificationToken(row.verificationTokenEncrypted);
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    certificateStatus: row.certificateStatus,
    aVerifiedAt: row.aVerifiedAt,
    txtVerifiedAt: row.txtVerifiedAt,
    dnsVerifiedAt: row.dnsVerifiedAt,
    routeProvisionedAt: row.routeProvisionedAt,
    certificateReadyAt: row.certificateReadyAt,
    certificateExpiresAt: row.certificateExpiresAt,
    lastCheckedAt: row.lastCheckedAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    disabledAt: row.disabledAt,
    dns: {
      ipv4: infra.ipv4 ?? null,
      ipv6: infra.ipv6,
      verificationRecordName: `_ai-caller-verify.${row.hostname}`,
      verificationRecordValue: `aicaller-verification=${token}`,
    },
  };
}

async function findActiveForBrand(tx: Tx | typeof db, brandId: string) {
  const [row] = await tx.select().from(whitelabelDomains)
    .where(and(
      eq(whitelabelDomains.brandId, brandId),
      ne(whitelabelDomains.status, "DISABLED"),
    ))
    .orderBy(desc(whitelabelDomains.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getWhitelabelDomainState(purchaserUserId: string) {
  const brand = await ensureBrandForPurchaser(purchaserUserId);
  const row = await findActiveForBrand(db, brand.id);
  return row ? toState(row) : null;
}

export async function claimWhitelabelDomain(purchaserUserId: string, rawHostname: string) {
  const brand = await ensureBrandForPurchaser(purchaserUserId);
  const infra = infrastructure(true);
  const hostname = normalizeWhitelabelHostname(rawHostname, infra.reservedHosts);

  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whitelabel-domain-brand:${brand.id}`}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whitelabel-domain-host:${hostname}`}))`);

    const existing = await findActiveForBrand(tx, brand.id);
    if (existing) {
      if (existing.hostname === hostname) return existing;
      throw new AppError(
        "WHITELABEL_DOMAIN_ALREADY_CONFIGURED",
        "Disconnect the existing custom domain before connecting another one.",
        409,
      );
    }

    const [claimed] = await tx.select({
      id: whitelabelDomains.id,
      purchaserUserId: whitelabelDomains.purchaserUserId,
    }).from(whitelabelDomains)
      .where(and(
        eq(whitelabelDomains.hostname, hostname),
        ne(whitelabelDomains.status, "DISABLED"),
      ))
      .limit(1);
    if (claimed) {
      throw new AppError(
        "WHITELABEL_DOMAIN_UNAVAILABLE",
        "This domain is already connected to another Whitelabel account.",
        409,
      );
    }

    const token = newVerificationToken();
    const [created] = await tx.insert(whitelabelDomains).values({
      brandId: brand.id,
      purchaserUserId,
      hostname,
      status: "AWAITING_DNS",
      verificationTokenEncrypted: encryptVerificationToken(token),
      certificateStatus: "NOT_REQUESTED",
    }).returning();
    return created;
  });

  return toState(row);
}

export async function rotateWhitelabelDomainVerification(purchaserUserId: string) {
  const brand = await ensureBrandForPurchaser(purchaserUserId);
  const updated = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whitelabel-domain-brand:${brand.id}`}))`);
    const existing = await findActiveForBrand(tx, brand.id);
    if (!existing) throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "No custom domain is connected.", 404);
    if (!["AWAITING_DNS", "DNS_MISMATCH"].includes(existing.status)) {
      throw new AppError(
        "WHITELABEL_DOMAIN_VERIFICATION_LOCKED",
        "DNS verification cannot be rotated after this domain has been verified.",
        409,
      );
    }
    const [row] = await tx.update(whitelabelDomains).set({
      verificationTokenEncrypted: encryptVerificationToken(newVerificationToken()),
      status: "AWAITING_DNS",
      aVerifiedAt: null,
      txtVerifiedAt: null,
      dnsVerifiedAt: null,
      lastCheckedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: new Date(),
    }).where(eq(whitelabelDomains.id, existing.id)).returning();
    return row;
  });
  return toState(updated);
}

export async function disconnectWhitelabelDomain(purchaserUserId: string) {
  const brand = await ensureBrandForPurchaser(purchaserUserId);
  const updated = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whitelabel-domain-brand:${brand.id}`}))`);
    const existing = await findActiveForBrand(tx, brand.id);
    if (!existing) throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "No custom domain is connected.", 404);
    const now = new Date();
    const [row] = await tx.update(whitelabelDomains).set({
      status: "DISABLED",
      disabledAt: now,
      updatedAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
    }).where(eq(whitelabelDomains.id, existing.id)).returning();
    return row;
  });
  return toState(updated);
}

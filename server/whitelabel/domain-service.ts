import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { ensureBrandForPurchaser } from "./brand-service";
import { normalizeWhitelabelHostname } from "./domain-hostname";
import { getWhitelabelDomainInfrastructure } from "./domain-config";
import {
  decryptWhitelabelDomainVerificationToken,
  encryptWhitelabelDomainVerificationToken,
  newWhitelabelDomainVerificationToken,
} from "./domain-token";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toState(row: typeof whitelabelDomains.$inferSelect) {
  const infra = getWhitelabelDomainInfrastructure();
  const token = decryptWhitelabelDomainVerificationToken(row.verificationTokenEncrypted);
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
  const infra = getWhitelabelDomainInfrastructure(true);
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

    const token = newWhitelabelDomainVerificationToken();
    const [created] = await tx.insert(whitelabelDomains).values({
      brandId: brand.id,
      purchaserUserId,
      hostname,
      status: "AWAITING_DNS",
      verificationTokenEncrypted: encryptWhitelabelDomainVerificationToken(token),
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
      verificationTokenEncrypted: encryptWhitelabelDomainVerificationToken(newWhitelabelDomainVerificationToken()),
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

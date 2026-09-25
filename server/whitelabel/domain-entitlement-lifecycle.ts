import { and, eq, ne } from "drizzle-orm";
import { licenses, memberships, whitelabelDomains, workspaceCommercialOwners } from "@/db/schema";

type Tx = Parameters<Parameters<(typeof import("@/db").db)["transaction"]>[0]>[0];

async function effectiveWhitelabelInTx(tx: Tx, purchaserUserId: string) {
  const primaries = await tx.select({ workspaceId: workspaceCommercialOwners.workspaceId })
    .from(workspaceCommercialOwners)
    .innerJoin(memberships, and(
      eq(memberships.workspaceId, workspaceCommercialOwners.workspaceId),
      eq(memberships.userId, purchaserUserId),
      eq(memberships.role, "OWNER"),
    ))
    .where(and(
      eq(workspaceCommercialOwners.purchaserUserId, purchaserUserId),
      eq(workspaceCommercialOwners.kind, "PRIMARY"),
    ))
    .limit(2);
  if (primaries.length !== 1) return false;

  const rows = await tx.select({ code: licenses.productCode }).from(licenses)
    .where(and(
      eq(licenses.workspaceId, primaries[0].workspaceId),
      eq(licenses.purchaserUserId, purchaserUserId),
      eq(licenses.status, "ACTIVE"),
    ));
  const products = new Set(rows.map((row) => row.code));
  return products.has("CORE")
    && products.has("WHITELABEL")
    && (products.has("AGENCY_50") || products.has("AGENCY_100"));
}

/**
 * Synchronize the public custom-domain lifecycle with the purchaser's
 * effective Core + Agency + Whitelabel commercial entitlement.
 *
 * Call this inside the SAME transaction that changes a prerequisite license so
 * the domain cannot observe an older billing state.
 */
export async function syncWhitelabelDomainEntitlementInTx(tx: Tx, purchaserUserId: string) {
  const effective = await effectiveWhitelabelInTx(tx, purchaserUserId);
  const [domain] = await tx.select().from(whitelabelDomains)
    .where(and(
      eq(whitelabelDomains.purchaserUserId, purchaserUserId),
      ne(whitelabelDomains.status, "DISABLED"),
    ))
    .limit(1);

  if (!domain) return { changed: false as const, effective, domainId: null };

  const now = new Date();
  if (!effective && domain.status !== "REVOKED") {
    const [updated] = await tx.update(whitelabelDomains).set({
      status: "REVOKED",
      lastErrorCode: "WHITELABEL_ENTITLEMENT_REVOKED",
      lastErrorMessage: "This custom domain is disabled because the Core, Agency and Whitelabel purchase requirements are no longer active.",
      updatedAt: now,
    }).where(and(
      eq(whitelabelDomains.id, domain.id),
      eq(whitelabelDomains.status, domain.status),
    )).returning();

    return {
      changed: Boolean(updated),
      effective,
      domainId: domain.id,
      status: updated?.status ?? domain.status,
    };
  }

  if (effective && domain.status === "REVOKED") {
    const [updated] = await tx.update(whitelabelDomains).set({
      status: "AWAITING_DNS",
      aVerifiedAt: null,
      txtVerifiedAt: null,
      dnsVerifiedAt: null,
      certificateStatus: "NOT_REQUESTED",
      certificateReadyAt: null,
      certificateExpiresAt: null,
      lastCheckedAt: null,
      lastErrorCode: "WHITELABEL_ENTITLEMENT_RESTORED",
      lastErrorMessage: "Commercial access was restored. Reverify DNS before this custom domain can return to service.",
      updatedAt: now,
    }).where(and(
      eq(whitelabelDomains.id, domain.id),
      eq(whitelabelDomains.status, "REVOKED"),
    )).returning();

    return {
      changed: Boolean(updated),
      effective,
      domainId: domain.id,
      status: updated?.status ?? domain.status,
    };
  }

  return { changed: false as const, effective, domainId: domain.id, status: domain.status };
}

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships, workspaceCommercialOwners } from "@/db/schema";
import { FUNNEL_PRODUCTS, getAgencyClientLimit, getPurchasedBusinessLimit, type FunnelProductCode } from "./products";

export type PurchaserLicense = {
  id: string;
  workspaceId: string;
  productCode: string;
  status: "ACTIVE" | "REFUNDED" | "CHARGEBACK" | "CANCELLED";
  purchasedAt: Date;
};

export type FunnelAccountSummary = {
  activeProducts: FunnelProductCode[];
  businessLimit: number;
  agencyClientLimit: number | null;
  /** A purchased Whitelabel receipt is usable only with Core and Agency. */
  effectiveWhitelabel: boolean;
  licenses: PurchaserLicense[];
};

/**
 * Account-level commercial capacity is derived from valid active purchases.
 * This is a read model, NOT workspace-creation authorization (implemented
 * separately together with atomic limits and legacy workspace reconciliation).
 * Neither a staff membership nor a stale workspace JSON field grants capacity.
 */
export function summarizeFunnelAccountLicenses(
  rows: PurchaserLicense[],
  primaryWorkspaceId?: string | null,
): FunnelAccountSummary {
  const activeProducts = FUNNEL_PRODUCTS
    .filter((product) => rows.some((license) =>
      license.status === "ACTIVE" && license.productCode === product.code))
    .map((product) => product.code);
  const activeLicenseCodes = rows
    .filter((license) => license.status === "ACTIVE")
    .map((license) => license.productCode);
  const businessLimit = getPurchasedBusinessLimit(activeLicenseCodes);
  const agencyClientLimit = getAgencyClientLimit(activeLicenseCodes);
  // Core + Agency + Whitelabel must be anchored to one business, not
  // combined from unrelated receipts on different workspaces.
  const activeByWorkspace = new Map<string, Set<string>>();
  for (const license of rows) {
    if (license.status !== "ACTIVE") continue;
    const products = activeByWorkspace.get(license.workspaceId) ?? new Set<string>();
    products.add(license.productCode);
    activeByWorkspace.set(license.workspaceId, products);
  }
  const effectiveWhitelabel = Array.from(activeByWorkspace.entries()).some(([workspaceId, products]) =>
    (primaryWorkspaceId === undefined || workspaceId === primaryWorkspaceId)
      && products.has("CORE") && products.has("WHITELABEL")
      && (products.has("AGENCY_50") || products.has("AGENCY_100")));
  return { activeProducts, businessLimit, agencyClientLimit, effectiveWhitelabel, licenses: rows };
}

export async function getFunnelAccountSummary(purchaserUserId: string): Promise<FunnelAccountSummary> {
  const rows = await db.select({
    id: licenses.id,
    workspaceId: licenses.workspaceId,
    productCode: licenses.productCode,
    status: licenses.status,
    purchasedAt: licenses.purchasedAt,
  })
    .from(licenses)
    .where(eq(licenses.purchaserUserId, purchaserUserId))
    .orderBy(desc(licenses.purchasedAt), desc(licenses.id));
  const summary = summarizeFunnelAccountLicenses(rows);
  if (!summary.effectiveWhitelabel) return summary;

  // The public purchase summary is not sufficient authorization by itself:
  // only receipts on the purchaser's ONE original, still-owned business can
  // become an operational Whitelabel package.
  const primaries = await db.select({ workspaceId: workspaceCommercialOwners.workspaceId })
    .from(workspaceCommercialOwners)
    .innerJoin(memberships, and(
      eq(memberships.workspaceId, workspaceCommercialOwners.workspaceId),
      eq(memberships.userId, purchaserUserId),
      eq(memberships.role, "OWNER"),
    ))
    .where(and(
      eq(workspaceCommercialOwners.purchaserUserId, purchaserUserId),
      eq(workspaceCommercialOwners.kind, "PRIMARY"),
    )).limit(2);
  return summarizeFunnelAccountLicenses(
    rows,
    primaries.length === 1 ? primaries[0].workspaceId : null,
  );
}

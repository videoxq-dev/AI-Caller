import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { licenses } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type WorkspaceProvisioningSource = "PRIMARY" | "UNLIMITED" | "AGENCY" | "LEGACY";

/**
 * New workspace origin is written atomically at provisioning and survives
 * refunds and upgrades. Legacy additional workspaces predate that marker:
 * retain the previous date heuristic only for those unreconciled records.
 * A provider-supplied purchasedAt must never classify a NEW client.
 */
export async function wasProvisionedForAgency(
  purchaserUserId: string,
  commercialOwnershipCreatedAt: Date,
  source: WorkspaceProvisioningSource,
  query: Tx | typeof db = db,
) {
  if (source === "AGENCY") return true;
  if (source === "UNLIMITED" || source === "PRIMARY") return false;

  const [agencyAtCreation] = await query.select({ id: licenses.id }).from(licenses)
    .where(and(
      eq(licenses.purchaserUserId, purchaserUserId),
      inArray(licenses.productCode, ["AGENCY_50", "AGENCY_100"]),
      lte(licenses.purchasedAt, commercialOwnershipCreatedAt),
    ))
    .limit(1);
  return Boolean(agencyAtCreation);
}

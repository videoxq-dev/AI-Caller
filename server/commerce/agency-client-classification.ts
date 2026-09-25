import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { licenses } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Agency client status is historical, not determined by today's active Agency
 * receipts. A subsequent Agency refund must not accidentally grant a former
 * Core-only client the purchaser's Unlimited features.
 *
 * ADDITIONAL workspaces created before the purchaser bought Agency remain
 * eligible for their independently purchased Unlimited second-business offer.
 */
export async function wasProvisionedForAgency(
  purchaserUserId: string,
  commercialOwnershipCreatedAt: Date,
  query: Tx | typeof db = db,
) {
  const [agencyAtCreation] = await query.select({ id: licenses.id }).from(licenses)
    .where(and(
      eq(licenses.purchaserUserId, purchaserUserId),
      inArray(licenses.productCode, ["AGENCY_50", "AGENCY_100"]),
      lte(licenses.purchasedAt, commercialOwnershipCreatedAt),
    ))
    .limit(1);
  return Boolean(agencyAtCreation);
}

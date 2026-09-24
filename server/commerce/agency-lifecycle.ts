import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships, user } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { resolveFunnelProductId, type FunnelProductCode } from "./products";
import type { NormalizedPurchaseEvent } from "./types";

const ACTIVE_EVENTS = new Set(["SALE", "BILL", "UNCANCEL-REBILL"]);
const REVOKE_EVENTS = new Set(["RFND", "CGBK", "INSF", "CANCEL-REBILL"]);
const AGENCY_PRODUCTS = ["AGENCY_50", "AGENCY_100"] as const;

type AgencyProductCode = Extract<FunnelProductCode, "AGENCY_50" | "AGENCY_100">;

function agencySku(event: NormalizedPurchaseEvent): AgencyProductCode {
  const product = resolveFunnelProductId(event.productId);
  if (event.source !== "JVZOO" || (product !== "AGENCY_50" && product !== "AGENCY_100")) {
    throw new AppError("FUNNEL_LICENSE_NOT_ELIGIBLE", "A configured Agency purchase is required.", 409);
  }
  return product;
}

/**
 * Reconcile one verified Agency receipt.
 *
 * Agency capacity belongs to the purchasing account and is anchored to the
 * purchaser's original active Core business. Purchasing Agency never creates
 * client workspaces; it only authorizes their later creation.
 */
export async function reconcileAgencyReceipt(event: NormalizedPurchaseEvent) {
  const productCode = agencySku(event);
  if (!ACTIVE_EVENTS.has(event.eventType) && !REVOKE_EVENTS.has(event.eventType)) {
    return { ignored: true as const, reason: "UNSUPPORTED_EVENT" };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agency-receipt:${event.externalPurchaseId}`}))`);

    const [existing] = await tx.select().from(licenses).where(and(
      eq(licenses.source, "JVZOO"),
      eq(licenses.externalPurchaseId, event.externalPurchaseId),
      inArray(licenses.productCode, [...AGENCY_PRODUCTS]),
    )).limit(1);

    let license = existing;
    if (license) {
      if (license.productCode !== productCode) {
        throw new AppError(
          "PURCHASE_OWNERSHIP_CONFLICT",
          "This Agency receipt is already associated with another Agency package.",
          409,
        );
      }
      const [buyer] = license.purchaserUserId
        ? await tx.select({ email: user.email }).from(user)
          .where(eq(user.id, license.purchaserUserId)).limit(1)
        : [];
      if (!buyer || buyer.email.toLowerCase() !== event.customerEmail.toLowerCase()) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "The Agency receipt belongs to another buyer.", 409);
      }
    } else {
      if (!ACTIVE_EVENTS.has(event.eventType)) {
        throw new AppError("LICENSE_NOT_FOUND", "Retry this event after its original purchase arrives.", 503);
      }
      if (event.eventType === "UNCANCEL-REBILL") {
        throw new AppError("LICENSE_NOT_FOUND", "Cannot restore an unknown Agency receipt.", 503);
      }

      const [buyer] = await tx.select({ id: user.id }).from(user)
        .where(eq(user.email, event.customerEmail)).limit(1);
      if (!buyer) {
        throw new AppError("FUNNEL_CORE_PURCHASE_REQUIRED", "The buyer must have an active Core purchase.", 409);
      }

      const [core] = await tx.select({ workspaceId: licenses.workspaceId })
        .from(licenses)
        .innerJoin(memberships, and(
          eq(memberships.workspaceId, licenses.workspaceId),
          eq(memberships.userId, buyer.id),
        ))
        .where(and(
          eq(licenses.purchaserUserId, buyer.id),
          eq(licenses.productCode, "CORE"),
          eq(licenses.status, "ACTIVE"),
          eq(memberships.role, "OWNER"),
        ))
        .orderBy(asc(licenses.purchasedAt), asc(licenses.id))
        .limit(1);
      if (!core) {
        throw new AppError("FUNNEL_CORE_PURCHASE_REQUIRED", "The buyer must have an active Core purchase.", 409);
      }

      [license] = await tx.insert(licenses).values({
        workspaceId: core.workspaceId,
        purchaserUserId: buyer.id,
        source: "JVZOO",
        externalPurchaseId: event.externalPurchaseId,
        productCode,
        status: "ACTIVE",
        purchasedAt: event.purchasedAt,
        rawMetadata: event.raw,
      }).onConflictDoNothing().returning();
      if (!license) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "The Agency receipt needs ownership reconciliation.", 409);
      }
    }

    if (ACTIVE_EVENTS.has(event.eventType)) {
      if (
        license.status === "REFUNDED"
        || license.status === "CHARGEBACK"
        || (license.status === "CANCELLED" && event.eventType !== "UNCANCEL-REBILL")
      ) {
        return { ignored: true as const, reason: "REVOKED_PURCHASE" };
      }

      const [currentOwner] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(
        eq(memberships.workspaceId, license.workspaceId),
        eq(memberships.userId, license.purchaserUserId ?? ""),
        eq(memberships.role, "OWNER"),
      )).limit(1);
      if (!currentOwner) {
        throw new AppError(
          "PURCHASE_OWNERSHIP_CONFLICT",
          "The Agency purchaser no longer owns the original business.",
          409,
        );
      }

      if (license.status === "CANCELLED") {
        const [reactivated] = await tx.update(licenses).set({
          status: "ACTIVE",
          rawMetadata: event.raw,
          updatedAt: new Date(),
        }).where(eq(licenses.id, license.id)).returning();
        license = reactivated;
      } else {
        const [updated] = await tx.update(licenses).set({
          rawMetadata: event.raw,
          updatedAt: new Date(),
        }).where(eq(licenses.id, license.id)).returning();
        license = updated;
      }

      return {
        ignored: false as const,
        workspaceId: license.workspaceId,
        licenseId: license.id,
        productCode: license.productCode as AgencyProductCode,
        status: license.status,
      };
    }

    const status = license.status === "CHARGEBACK" || event.eventType === "CGBK"
      ? "CHARGEBACK" as const
      : license.status === "REFUNDED" || event.eventType === "RFND"
        ? "REFUNDED" as const
        : "CANCELLED" as const;

    const [updated] = await tx.update(licenses).set({
      status,
      rawMetadata: event.raw,
      updatedAt: new Date(),
    }).where(eq(licenses.id, license.id)).returning();

    // Agency financial state affects future Agency access/capacity only.
    // Existing workspaces and their data are deliberately preserved.
    return {
      ignored: false as const,
      workspaceId: updated.workspaceId,
      licenseId: updated.id,
      productCode: updated.productCode as AgencyProductCode,
      status: updated.status,
    };
  });
}

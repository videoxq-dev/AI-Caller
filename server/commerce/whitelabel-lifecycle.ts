import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships, user, workspaceCommercialOwners } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { syncWhitelabelDomainEntitlementInTx } from "@/server/whitelabel/domain-entitlement-lifecycle";
import { resolveFunnelProductId } from "./products";
import type { NormalizedPurchaseEvent } from "./types";

const ACTIVE_EVENTS = new Set(["SALE", "BILL", "UNCANCEL-REBILL"]);
const REVOKE_EVENTS = new Set(["RFND", "CGBK", "INSF", "CANCEL-REBILL"]);

/**
 * Stage an independently owned Whitelabel receipt without enabling public
 * checkout/IPN provisioning. Whitelabel becomes usable only when the same
 * purchaser also has active Core and Agency; this function does not add
 * workspaces, credits or provider routing. Existing custom-domain lifecycle
 * state is synchronized atomically with the commercial prerequisite state.
 */
export async function reconcileWhitelabelReceipt(event: NormalizedPurchaseEvent) {
  if (event.source !== "JVZOO" || resolveFunnelProductId(event.productId) !== "WHITELABEL") {
    throw new AppError("FUNNEL_LICENSE_NOT_ELIGIBLE", "A configured Whitelabel purchase is required.", 409);
  }
  if (!ACTIVE_EVENTS.has(event.eventType) && !REVOKE_EVENTS.has(event.eventType)) {
    return { ignored: true as const, reason: "UNSUPPORTED_EVENT" };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whitelabel-receipt:${event.externalPurchaseId}`}))`);
    const matching = await tx.select().from(licenses).where(and(
      eq(licenses.source, "JVZOO"),
      eq(licenses.externalPurchaseId, event.externalPurchaseId),
    ));
    if (matching.some((row) => row.productCode !== "WHITELABEL")) {
      throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "This receipt is associated with another product.", 409);
    }

    let license = matching[0];
    if (license) {
      const [buyer] = license.purchaserUserId
        ? await tx.select({ email: user.email }).from(user)
          .where(eq(user.id, license.purchaserUserId)).limit(1)
        : [];
      if (!buyer || buyer.email.toLowerCase() !== event.customerEmail.toLowerCase()) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "This Whitelabel receipt belongs to another purchaser.", 409);
      }
    } else {
      if (!ACTIVE_EVENTS.has(event.eventType) || event.eventType === "UNCANCEL-REBILL") {
        throw new AppError("LICENSE_NOT_FOUND", "Retry after the original Whitelabel sale has been recorded.", 503);
      }
      const [buyer] = await tx.select({ id: user.id }).from(user)
        .where(eq(user.email, event.customerEmail)).limit(1);
      if (!buyer) {
        throw new AppError("FUNNEL_CORE_PURCHASE_REQUIRED", "The buyer must have an active Core purchase.", 409);
      }
      const [core] = await tx.select({ workspaceId: licenses.workspaceId }).from(licenses)
        .innerJoin(workspaceCommercialOwners, and(
          eq(workspaceCommercialOwners.workspaceId, licenses.workspaceId),
          eq(workspaceCommercialOwners.purchaserUserId, buyer.id),
          eq(workspaceCommercialOwners.kind, "PRIMARY"),
        ))
        .innerJoin(memberships, and(
          eq(memberships.workspaceId, licenses.workspaceId),
          eq(memberships.userId, buyer.id),
          eq(memberships.role, "OWNER"),
        ))
        .where(and(
          eq(licenses.purchaserUserId, buyer.id),
          eq(licenses.productCode, "CORE"),
          eq(licenses.status, "ACTIVE"),
        ))
        .orderBy(asc(licenses.purchasedAt), asc(licenses.id))
        .limit(1);
      if (!core) {
        throw new AppError("FUNNEL_CORE_PURCHASE_REQUIRED", "The buyer must have an active Core purchase on their original business.", 409);
      }

      [license] = await tx.insert(licenses).values({
        workspaceId: core.workspaceId, purchaserUserId: buyer.id,
        source: "JVZOO", externalPurchaseId: event.externalPurchaseId,
        productCode: "WHITELABEL", status: "ACTIVE",
        purchasedAt: event.purchasedAt, rawMetadata: event.raw,
      }).onConflictDoNothing().returning();
      if (!license) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "This receipt needs ownership reconciliation.", 409);
      }
    }

    if (ACTIVE_EVENTS.has(event.eventType)) {
      if (license.status === "REFUNDED" || license.status === "CHARGEBACK"
        || (license.status === "CANCELLED" && event.eventType !== "UNCANCEL-REBILL")) {
        return { ignored: true as const, reason: "REVOKED_PURCHASE" };
      }
      const [owner] = await tx.select({ purchaserUserId: workspaceCommercialOwners.purchaserUserId })
        .from(workspaceCommercialOwners)
        .innerJoin(memberships, and(
          eq(memberships.workspaceId, workspaceCommercialOwners.workspaceId),
          eq(memberships.userId, workspaceCommercialOwners.purchaserUserId),
          eq(memberships.role, "OWNER"),
        ))
        .where(and(
          eq(workspaceCommercialOwners.workspaceId, license.workspaceId),
          eq(workspaceCommercialOwners.kind, "PRIMARY"),
          eq(workspaceCommercialOwners.purchaserUserId, license.purchaserUserId ?? ""),
        ))
        .limit(1);
      if (!owner) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "The original business is no longer commercially owned by this purchaser.", 409);
      }

      [license] = await tx.update(licenses).set({
        ...(license.status === "CANCELLED" ? { status: "ACTIVE" as const } : {}),
        rawMetadata: event.raw, updatedAt: new Date(),
      }).where(eq(licenses.id, license.id)).returning();
    } else {
      const status = license.status === "CHARGEBACK" || event.eventType === "CGBK"
        ? "CHARGEBACK" as const
        : license.status === "REFUNDED" || event.eventType === "RFND"
          ? "REFUNDED" as const
          : "CANCELLED" as const;
      [license] = await tx.update(licenses).set({
        status, rawMetadata: event.raw, updatedAt: new Date(),
      }).where(eq(licenses.id, license.id)).returning();
    }

    if (license.purchaserUserId) {
      await syncWhitelabelDomainEntitlementInTx(tx, license.purchaserUserId);
    }
    return {
      ignored: false as const, workspaceId: license.workspaceId,
      licenseId: license.id, productCode: "WHITELABEL" as const,
      status: license.status,
    };
  });
}

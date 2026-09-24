import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships, user } from "@/db/schema";
import { grantUnlimitedPurchaseCreditsInTx, reverseUnlimitedPurchaseCreditsInTx } from "@/server/credits/service";
import { AppError } from "@/server/http/errors";
import { resolveFunnelProductId } from "./products";
import type { NormalizedPurchaseEvent } from "./types";

const ACTIVE_EVENTS = new Set(["SALE", "BILL", "UNCANCEL-REBILL"]);
const REVOKE_EVENTS = new Set(["RFND", "CGBK", "INSF", "CANCEL-REBILL"]);

/**
 * Internal, transaction-safe Unlimited upgrade receipt reconciliation.
 *
 * Do not call this directly from a public route. Live JVZoo ingress still
 * rejects Unlimited until its promised features and acceptance are complete.
 * The future commerce dispatcher must call this only AFTER verifying the IPN.
 */
export async function reconcileUnlimitedReceipt(event: NormalizedPurchaseEvent) {
  if (event.source !== "JVZOO" || resolveFunnelProductId(event.productId) !== "UNLIMITED") {
    throw new AppError("FUNNEL_LICENSE_NOT_ELIGIBLE", "A configured Unlimited purchase is required.", 409);
  }
  if (!ACTIVE_EVENTS.has(event.eventType) && !REVOKE_EVENTS.has(event.eventType)) {
    return { ignored: true as const, reason: "UNSUPPORTED_EVENT" };
  }

  return db.transaction(async (tx) => {
    // This lock covers receipt discovery, owner binding, license transitions and
    // credits. Two events for the same receipt cannot reverse their order
    // midway through fulfillment, nor grant after a committed refund.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`unlimited-receipt:${event.externalPurchaseId}`}))`);
    const [existing] = await tx.select().from(licenses).where(and(
      eq(licenses.source, "JVZOO"),
      eq(licenses.externalPurchaseId, event.externalPurchaseId),
      eq(licenses.productCode, "UNLIMITED"),
    )).limit(1);

    let license = existing;
    if (license) {
      const [buyer] = license.purchaserUserId
        ? await tx.select({ email: user.email }).from(user)
          .where(eq(user.id, license.purchaserUserId)).limit(1)
        : [];
      if (!buyer || buyer.email.toLowerCase() !== event.customerEmail.toLowerCase()) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "The Unlimited receipt belongs to another buyer.", 409);
      }
    } else {
      if (!ACTIVE_EVENTS.has(event.eventType)) {
        throw new AppError("LICENSE_NOT_FOUND", "Retry this event after its original purchase arrives.", 503);
      }
      if (event.eventType === "UNCANCEL-REBILL") {
        throw new AppError("LICENSE_NOT_FOUND", "Cannot restore an unknown Unlimited receipt.", 503);
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
        productCode: "UNLIMITED",
        status: "ACTIVE",
        purchasedAt: event.purchasedAt,
        rawMetadata: event.raw,
      }).onConflictDoNothing().returning();
      if (!license) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "The Unlimited receipt needs ownership reconciliation.", 409);
      }
    }

    if (ACTIVE_EVENTS.has(event.eventType)) {
      if (license.status === "REFUNDED" || license.status === "CHARGEBACK"
        || (license.status === "CANCELLED" && event.eventType !== "UNCANCEL-REBILL")) {
        return { ignored: true as const, reason: "REVOKED_PURCHASE" };
      }
      // Refunded receipts must still reverse credits if business ownership has
      // changed. Activation is different: never grant an old buyer's bonus to
      // a business they no longer own.
      const [currentOwner] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(
        eq(memberships.workspaceId, license.workspaceId),
        eq(memberships.userId, license.purchaserUserId ?? ""),
        eq(memberships.role, "OWNER"),
      )).limit(1);
      if (!currentOwner) {
        throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "The Unlimited business is no longer owned by its purchaser.", 409);
      }
      if (license.status === "CANCELLED") {
        const [reactivated] = await tx.update(licenses).set({
          status: "ACTIVE", rawMetadata: event.raw, updatedAt: new Date(),
        }).where(eq(licenses.id, license.id)).returning();
        license = reactivated;
      }
      const balance = await grantUnlimitedPurchaseCreditsInTx(tx, license.workspaceId, license.id);
      return { ignored: false as const, workspaceId: license.workspaceId, licenseId: license.id, balance };
    }

    const status = license.status === "CHARGEBACK" || event.eventType === "CGBK"
      ? "CHARGEBACK" as const
      : license.status === "REFUNDED" || event.eventType === "RFND"
        ? "REFUNDED" as const
        : "CANCELLED" as const;
    await tx.update(licenses).set({ status, rawMetadata: event.raw, updatedAt: new Date() })
      .where(eq(licenses.id, license.id));
    if (status === "REFUNDED" || status === "CHARGEBACK") {
      await reverseUnlimitedPurchaseCreditsInTx(tx, license.workspaceId, license.id);
    }
    // An Unlimited refund never changes Core workspace state or Core entitlement.
    return { ignored: false as const, workspaceId: license.workspaceId, licenseId: license.id, status };
  });
}

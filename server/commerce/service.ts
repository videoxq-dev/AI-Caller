import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  commerceEvents,
  licenses,
  memberships,
  user,
  workspaceEntitlements,
  workspaces,
} from "@/db/schema";
import { auth } from "@/server/auth";
import { createWorkspaceForUser, ensureDefaultWorkspace, getMembership, getPrimaryOwnedWorkspace } from "@/server/auth/workspace-repository";
import { grantStarterCredits } from "@/server/credits/service";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { enqueueJob } from "@/server/jobs";
import { COMMERCE_WELCOME_EMAIL } from "@/server/jobs/queues";
import type { NormalizedPurchaseEvent } from "./types";
import { resolveFunnelProductId } from "./products";

const ACTIVE_EVENTS = new Set(["SALE", "BILL", "UNCANCEL-REBILL"]);
const REVOKE_EVENTS = new Set(["RFND", "CGBK", "INSF", "CANCEL-REBILL"]);

function isCoreProduct(productId: string): boolean {
  const env = getEnv();
  if (env.NODE_ENV === "production" && !env.JVZOO_CORE_PRODUCT_IDS.split(",").some((id) => id.trim())) {
    throw new Error("JVZOO_CORE_PRODUCT_IDS must be configured in production.");
  }
  // Only Core has purchase provisioning at this milestone. Mapping an OTO in
  // configuration must never grant Core or unlock an unfinished offer.
  return resolveFunnelProductId(productId, env) === "CORE";
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function grantCoreEntitlements(workspaceId: string, tx: Tx) {
  const entries: Array<[string, unknown]> = [
    ["workspace_limit", 1],
    ["calendar_connection_limit", 1],
    ["multiple_agents", false],
    ["visual_automation_builder", false],
    ["core_access", true],
  ];
  for (const [key, value] of entries) {
    await tx
      .insert(workspaceEntitlements)
      .values({ workspaceId, key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [workspaceEntitlements.workspaceId, workspaceEntitlements.key],
        set: { value, updatedAt: new Date() },
      });
  }
}

async function provisionUser(event: NormalizedPurchaseEvent) {
  const [existing] = await db.select().from(user).where(eq(user.email, event.customerEmail)).limit(1);
  if (existing) {
    const membership = await getPrimaryOwnedWorkspace(existing.id)
      ?? await createWorkspaceForUser(existing.id, existing.name.trim() ? `${existing.name.trim()}'s Business` : "My Business");
    return { user: existing, workspace: membership, created: false, temporaryPassword: null as string | null };
  }

  const temporaryPassword = randomBytes(18).toString("base64url");
  await auth.api.signUpEmail({
    body: {
      name: event.customerName,
      email: event.customerEmail,
      password: temporaryPassword,
    },
  });

  const [created] = await db.select().from(user).where(eq(user.email, event.customerEmail)).limit(1);
  if (!created) throw new Error("JVZoo account provisioning did not create a user.");
  const membership = await ensureDefaultWorkspace(created);
  return { user: created, workspace: membership, created: true, temporaryPassword };
}

async function activate(event: NormalizedPurchaseEvent) {
  if (!isCoreProduct(event.productId)) return { ignored: true as const, reason: "UNMAPPED_PRODUCT" };

  const [existingLicense] = await db.select().from(licenses).where(and(
    eq(licenses.source, "JVZOO"),
    eq(licenses.externalPurchaseId, event.externalPurchaseId),
    eq(licenses.productCode, "CORE"),
  )).limit(1);

  // A late SALE/BILL cannot revive a refunded or chargeback receipt. Only an
  // explicit uncancellation may restore a cancelled recurring receipt.
  if (existingLicense && (
    existingLicense.status === "REFUNDED"
    || existingLicense.status === "CHARGEBACK"
    || (existingLicense.status === "CANCELLED" && event.eventType !== "UNCANCEL-REBILL")
  )) return { ignored: true as const, reason: "REVOKED_PURCHASE" };
  if (!existingLicense && event.eventType === "UNCANCEL-REBILL") {
    throw new AppError("LICENSE_NOT_FOUND", "Cannot restore a receipt before its original purchase is known.", 503);
  }

  let provisioned: Awaited<ReturnType<typeof provisionUser>>;
  if (existingLicense) {
    const [buyer] = existingLicense.purchaserUserId
      ? await db.select().from(user).where(eq(user.id, existingLicense.purchaserUserId)).limit(1)
      : [];
    const owned = buyer ? await getMembership(buyer.id, existingLicense.workspaceId) : null;
    if (!buyer || buyer.email.toLowerCase() !== event.customerEmail.toLowerCase() || owned?.role !== "OWNER") {
      throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "This receipt is associated with another purchaser or needs ownership reconciliation.", 409);
    }
    provisioned = { user: buyer, workspace: owned, created: false, temporaryPassword: null };
  } else {
    provisioned = await provisionUser(event);
  }

  const [license] = await db
    .insert(licenses)
    .values({
      workspaceId: provisioned.workspace.workspaceId,
      purchaserUserId: provisioned.user.id,
      source: "JVZOO",
      externalPurchaseId: event.externalPurchaseId,
      productCode: "CORE",
      status: "ACTIVE",
      purchasedAt: event.purchasedAt,
      rawMetadata: event.raw,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [licenses.source, licenses.externalPurchaseId, licenses.productCode],
      set: { status: "ACTIVE", rawMetadata: event.raw, updatedAt: new Date() },
      setWhere: and(
        eq(licenses.workspaceId, provisioned.workspace.workspaceId),
        eq(licenses.purchaserUserId, provisioned.user.id),
        event.eventType === "UNCANCEL-REBILL"
          ? inArray(licenses.status, ["ACTIVE", "CANCELLED"])
          : eq(licenses.status, "ACTIVE"),
      ),
    })
    .returning();

  // A concurrent IPN with the same receipt must not move access or credit grants
  // to a second account, even if both events raced through the initial lookup.
  if (!license) {
    // A refund can win between the initial ACTIVE read and this guarded
    // upsert. Treat a matching, now-revoked receipt as a stale billing event,
    // not as a different account trying to claim this receipt.
    const [current] = await db.select({
      workspaceId: licenses.workspaceId,
      purchaserUserId: licenses.purchaserUserId,
      status: licenses.status,
    }).from(licenses).where(and(
      eq(licenses.source, "JVZOO"),
      eq(licenses.externalPurchaseId, event.externalPurchaseId),
      eq(licenses.productCode, "CORE"),
    )).limit(1);
    if (current?.workspaceId === provisioned.workspace.workspaceId
      && current.purchaserUserId === provisioned.user.id
      && current.status !== "ACTIVE") {
      return { ignored: true as const, reason: "REVOKED_PURCHASE" };
    }
  }
  if (!license || license.workspaceId !== provisioned.workspace.workspaceId || license.purchaserUserId !== provisioned.user.id) {
    throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "This receipt is associated with another purchaser or needs ownership reconciliation.", 409);
  }
  // Purchase and refund IPNs can overlap. Use the same per-business lock as
  // revocation and re-check the row after acquiring it: an earlier ACTIVE
  // upsert is not proof the receipt is still ACTIVE when access is written.
  const canActivate = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`core-license:${license.workspaceId}`}))`);
    const [current] = await tx.select({ status: licenses.status }).from(licenses)
      .where(eq(licenses.id, license.id)).limit(1);
    if (current?.status !== "ACTIVE") return false;
    await tx.update(workspaces).set({ status: "ACTIVE", updatedAt: new Date() })
      .where(eq(workspaces.id, license.workspaceId));
    await grantCoreEntitlements(license.workspaceId, tx);
    return true;
  });
  if (!canActivate) return { ignored: true as const, reason: "REVOKED_PURCHASE" };
  const balance = await grantStarterCredits(license.workspaceId, license.id);

  if (provisioned.created && provisioned.temporaryPassword) {
    await enqueueJob(COMMERCE_WELCOME_EMAIL, {
      to: provisioned.user.email,
      name: provisioned.user.name,
      temporaryPassword: provisioned.temporaryPassword,
      signInUrl: `${getEnv().BETTER_AUTH_URL.replace(/\/$/, "")}/sign-in`,
    });
  }

  return { ignored: false as const, workspaceId: provisioned.workspace.workspaceId, licenseId: license.id, balance };
}

async function revoke(event: NormalizedPurchaseEvent) {
  if (!isCoreProduct(event.productId)) return { ignored: true as const, reason: "UNMAPPED_PRODUCT" };
  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.source, "JVZOO"), eq(licenses.externalPurchaseId, event.externalPurchaseId), eq(licenses.productCode, "CORE")))
    .limit(1);
  if (!license) {
    // Provider IPNs are not guaranteed to be delivered in purchase-first order.
    // A missing refund must be retryable after its purchase is recorded.
    throw new AppError("LICENSE_NOT_FOUND", "This receipt has not been recorded yet; retry after its sale arrives.", 503);
  }
  if (license.purchaserUserId) {
    const [buyer] = await db.select({ email: user.email }).from(user)
      .where(eq(user.id, license.purchaserUserId)).limit(1);
    if (!buyer || buyer.email.toLowerCase() !== event.customerEmail.toLowerCase()) {
      throw new AppError("PURCHASE_OWNERSHIP_CONFLICT", "This receipt is associated with another purchaser.", 409);
    }
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`core-license:${license.workspaceId}`}))`);
    // Resolve financial status after acquiring the lock: concurrent refund and
    // chargeback events must not race to overwrite the final classification.
    const [locked] = await tx.select({ status: licenses.status })
      .from(licenses).where(eq(licenses.id, license.id)).limit(1);
    if (!locked) throw new AppError("LICENSE_NOT_FOUND", "This receipt no longer exists.", 503);
    const status = locked.status === "CHARGEBACK" || event.eventType === "CGBK"
      ? "CHARGEBACK"
      : locked.status === "REFUNDED" || event.eventType === "RFND"
        ? "REFUNDED"
        : "CANCELLED";
    await tx.update(licenses).set({ status, rawMetadata: event.raw, updatedAt: new Date() })
      .where(eq(licenses.id, license.id));
    const [stillActive] = await tx.select({ id: licenses.id }).from(licenses).where(and(
      eq(licenses.workspaceId, license.workspaceId),
      eq(licenses.productCode, "CORE"),
      eq(licenses.status, "ACTIVE"),
    )).limit(1);
    const coreAccess = Boolean(stillActive);
    if (!coreAccess) {
      await tx.update(workspaces).set({ status: "SUSPENDED", updatedAt: new Date() })
        .where(eq(workspaces.id, license.workspaceId));
    }
    await tx.insert(workspaceEntitlements)
      .values({ workspaceId: license.workspaceId, key: "core_access", value: coreAccess, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [workspaceEntitlements.workspaceId, workspaceEntitlements.key],
        set: { value: coreAccess, updatedAt: new Date() },
      });
    return { ignored: false as const, workspaceId: license.workspaceId, licenseId: license.id, coreAccess };
  });
}

export async function processCommerceEvent(event: NormalizedPurchaseEvent) {
  const sku = resolveFunnelProductId(event.productId);
  if (sku && sku !== "CORE") {
    // Never acknowledge an OTO purchase as processed while its provisioning
    // is unavailable. Do this before recording the event so provider retries
    // cannot be consumed as irrevocable "IGNORED" events.
    throw new AppError("FUNNEL_OFFER_NOT_READY", "This funnel offer is not yet enabled for purchase provisioning.", 503);
  }

  const [stored] = await db
    .insert(commerceEvents)
    .values({
      source: event.source,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      status: "RECEIVED",
      payload: event.raw,
    })
    .onConflictDoUpdate({
      target: [commerceEvents.source, commerceEvents.externalEventId],
      set: {
        status: "RECEIVED",
        eventType: event.eventType,
        payload: event.raw,
        error: null,
        processedAt: null,
      },
      setWhere: eq(commerceEvents.status, "FAILED"),
    })
    .returning();

  // Only FAILED events are claimable again. PROCESSED, IGNORED and an
  // in-flight RECEIVED event retain their idempotent duplicate behavior.
  if (!stored) return { duplicate: true as const };

  try {
    let result: unknown;
    if (ACTIVE_EVENTS.has(event.eventType)) result = await activate(event);
    else if (REVOKE_EVENTS.has(event.eventType)) result = await revoke(event);
    else {
      result = { ignored: true, reason: "UNSUPPORTED_EVENT" };
    }

    const ignored = typeof result === "object" && result !== null && "ignored" in result && (result as { ignored?: boolean }).ignored === true;
    await db
      .update(commerceEvents)
      .set({ status: ignored ? "IGNORED" : "PROCESSED", processedAt: new Date() })
      .where(eq(commerceEvents.id, stored.id));
    return { duplicate: false as const, result };
  } catch (error) {
    await db
      .update(commerceEvents)
      .set({ status: "FAILED", error: error instanceof Error ? error.message : "Unknown error", processedAt: new Date() })
      .where(eq(commerceEvents.id, stored.id));
    throw error;
  }
}

export async function activateManualCoreLicense(workspaceId: string) {
  // Manual licensing may apply to unowned/bootstrap workspaces. Never guess
  // which purchaser owns a workspace with multiple OWNER memberships.
  const owners = await db.select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "OWNER")))
    .limit(2);
  const purchaserUserId = owners.length === 1 ? owners[0].userId : null;
  const externalPurchaseId = `manual:${workspaceId}`;
  const [license] = await db
    .insert(licenses)
    .values({
      workspaceId,
      purchaserUserId,
      source: "MANUAL",
      externalPurchaseId,
      productCode: "CORE",
      status: "ACTIVE",
      purchasedAt: new Date(),
      rawMetadata: { reason: "development/manual activation" },
    })
    .onConflictDoUpdate({
      target: [licenses.source, licenses.externalPurchaseId, licenses.productCode],
      set: { status: "ACTIVE", updatedAt: new Date() },
    })
    .returning();
  await db.transaction((tx) => grantCoreEntitlements(workspaceId, tx));
  const balance = await grantStarterCredits(workspaceId, license.id);
  return { license, balance };
}

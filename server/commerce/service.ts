import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  commerceEvents,
  licenses,
  user,
  workspaceEntitlements,
  workspaces,
} from "@/db/schema";
import { auth } from "@/server/auth";
import { ensureDefaultWorkspace } from "@/server/auth/workspace-repository";
import { grantStarterCredits } from "@/server/credits/service";
import { getEnv } from "@/server/env";
import { enqueueJob } from "@/server/jobs";
import { COMMERCE_WELCOME_EMAIL } from "@/server/jobs/queues";
import type { NormalizedPurchaseEvent } from "./types";

const ACTIVE_EVENTS = new Set(["SALE", "BILL", "UNCANCEL-REBILL"]);
const REVOKE_EVENTS = new Set(["RFND", "CGBK", "INSF"]);

function configuredCoreProducts(): Set<string> {
  return new Set(getEnv().JVZOO_CORE_PRODUCT_IDS.split(",").map((value) => value.trim()).filter(Boolean));
}

function isCoreProduct(productId: string): boolean {
  const configured = configuredCoreProducts();
  if (configured.size === 0) {
    if (getEnv().NODE_ENV === "production") {
      throw new Error("JVZOO_CORE_PRODUCT_IDS must be configured in production.");
    }
    return true;
  }
  return configured.has(productId);
}

async function grantCoreEntitlements(workspaceId: string) {
  const entries: Array<[string, unknown]> = [
    ["workspace_limit", 1],
    ["calendar_connection_limit", 1],
    ["multiple_agents", false],
    ["visual_automation_builder", false],
    ["core_access", true],
  ];
  for (const [key, value] of entries) {
    await db
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
    const membership = await ensureDefaultWorkspace(existing);
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

  const provisioned = await provisionUser(event);
  await db.update(workspaces).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(workspaces.id, provisioned.workspace.workspaceId));

  const [license] = await db
    .insert(licenses)
    .values({
      workspaceId: provisioned.workspace.workspaceId,
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
    })
    .returning();

  await grantCoreEntitlements(provisioned.workspace.workspaceId);
  const balance = await grantStarterCredits(provisioned.workspace.workspaceId, license.id);

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
  if (!license) return { ignored: true as const, reason: "LICENSE_NOT_FOUND" };

  const status = event.eventType === "CGBK" ? "CHARGEBACK" : event.eventType === "RFND" ? "REFUNDED" : "CANCELLED";
  await db.update(licenses).set({ status, rawMetadata: event.raw, updatedAt: new Date() }).where(eq(licenses.id, license.id));
  await db.update(workspaces).set({ status: "SUSPENDED", updatedAt: new Date() }).where(eq(workspaces.id, license.workspaceId));
  await db
    .insert(workspaceEntitlements)
    .values({ workspaceId: license.workspaceId, key: "core_access", value: false, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [workspaceEntitlements.workspaceId, workspaceEntitlements.key],
      set: { value: false, updatedAt: new Date() },
    });
  return { ignored: false as const, workspaceId: license.workspaceId, licenseId: license.id };
}

export async function processCommerceEvent(event: NormalizedPurchaseEvent) {
  const [stored] = await db
    .insert(commerceEvents)
    .values({
      source: event.source,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      status: "RECEIVED",
      payload: event.raw,
    })
    .onConflictDoNothing()
    .returning();

  if (!stored) return { duplicate: true as const };

  try {
    let result: unknown;
    if (ACTIVE_EVENTS.has(event.eventType)) result = await activate(event);
    else if (REVOKE_EVENTS.has(event.eventType)) result = await revoke(event);
    else if (event.eventType === "CANCEL-REBILL") {
      const [license] = await db
        .select()
        .from(licenses)
        .where(and(eq(licenses.source, "JVZOO"), eq(licenses.externalPurchaseId, event.externalPurchaseId), eq(licenses.productCode, "CORE")))
        .limit(1);
      if (license) await db.update(licenses).set({ status: "CANCELLED", updatedAt: new Date(), rawMetadata: event.raw }).where(eq(licenses.id, license.id));
      result = { ignored: false, cancellationRecorded: Boolean(license) };
    } else {
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
  const externalPurchaseId = `manual:${workspaceId}`;
  const [license] = await db
    .insert(licenses)
    .values({
      workspaceId,
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
  await grantCoreEntitlements(workspaceId);
  const balance = await grantStarterCredits(workspaceId, license.id);
  return { license, balance };
}

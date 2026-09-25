import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, licenses, memberships, workspaceCommercialOwners } from "@/db/schema";
import { wasProvisionedForAgency } from "./agency-client-classification";
import { AppError } from "@/server/http/errors";

export const CORE_CONTACT_LIMIT = 500;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resolveContactEntitlement(tx: Tx, workspaceId: string) {
  const [commercial] = await tx.select({
    purchaserUserId: workspaceCommercialOwners.purchaserUserId,
    kind: workspaceCommercialOwners.kind,
    provisioningSource: workspaceCommercialOwners.provisioningSource,
    createdAt: workspaceCommercialOwners.createdAt,
  }).from(workspaceCommercialOwners)
    .where(eq(workspaceCommercialOwners.workspaceId, workspaceId)).limit(1);
  let purchaserUserId: string;
  if (commercial) {
    purchaserUserId = commercial.purchaserUserId;
    if (commercial.kind === "ADDITIONAL"
      && await wasProvisionedForAgency(purchaserUserId, commercial.createdAt, commercial.provisioningSource, tx)) {
      return { limit: CORE_CONTACT_LIMIT as number | null, package: null as "UNLIMITED" | null };
    }
  } else {
    // Preserve a sole-owner fallback only for unreconciled historical records.
    const owners = await tx.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "OWNER")))
      .limit(2);
    if (owners.length !== 1) {
      return { limit: CORE_CONTACT_LIMIT as number | null, package: null as "UNLIMITED" | null };
    }
    purchaserUserId = owners[0].userId;
  }

  const [unlimited] = await tx.select({ id: licenses.id }).from(licenses).where(and(
    eq(licenses.purchaserUserId, purchaserUserId),
    eq(licenses.productCode, "UNLIMITED"),
    eq(licenses.status, "ACTIVE"),
  )).limit(1);

  return unlimited
    ? { limit: null, package: "UNLIMITED" as const }
    : { limit: CORE_CONTACT_LIMIT as number | null, package: null };
}

export async function getContactCapacity(workspaceId: string) {
  return db.transaction(async (tx) => {
    const [entitlement, [usage]] = await Promise.all([
      resolveContactEntitlement(tx, workspaceId),
      tx.select({ value: count() }).from(contacts).where(eq(contacts.workspaceId, workspaceId)),
    ]);
    return {
      ...entitlement,
      count: usage?.value ?? 0,
      remaining: entitlement.limit === null
        ? null
        : Math.max(0, entitlement.limit - (usage?.value ?? 0)),
    };
  });
}

export async function assertCanCreateContactInTx(tx: Tx, workspaceId: string) {
  // Serialize the final Core slot so two independent channels cannot create
  // contact 500 and 501 concurrently.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`contact-capacity:${workspaceId}`}))`);

  const entitlement = await resolveContactEntitlement(tx, workspaceId);
  if (entitlement.limit === null) return entitlement;

  const [usage] = await tx.select({ value: count() }).from(contacts)
    .where(eq(contacts.workspaceId, workspaceId));
  const contactCount = usage?.value ?? 0;
  if (contactCount >= entitlement.limit) {
    throw new AppError(
      "CONTACT_LIMIT_REACHED",
      "Core supports up to 500 contacts per business. Upgrade to Unlimited to add more contacts.",
      403,
      { contactCount, contactLimit: entitlement.limit },
    );
  }
  return entitlement;
}

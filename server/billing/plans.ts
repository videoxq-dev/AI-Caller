import { and, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { licenses, memberships, plans, workspaceCommercialOwners, workspaceInvitations, workspacePlans } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { wasProvisionedForAgency } from "@/server/commerce/agency-client-classification";

export type PlanCode = "PERSONAL" | "GROWTH";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockPlanEntitlements(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('plan-entitlements'))`);
}

async function lockSeats(tx: Tx, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan-seat:${workspaceId}`}))`);
}

export async function getWorkspacePlanInTransaction(tx: Tx, workspaceId: string) {
  const [assigned] = await tx
    .select({
      id: plans.id,
      name: plans.name,
      description: plans.description,
      active: plans.active,
      subUserLimit: plans.subUserLimit,
      metadata: plans.metadata,
      source: workspacePlans.source,
    })
    .from(workspacePlans)
    .innerJoin(plans, eq(workspacePlans.planId, plans.id))
    .where(eq(workspacePlans.workspaceId, workspaceId))
    .limit(1);

  if (assigned) return assigned;

  const [personal] = await tx
    .select({
      id: plans.id,
      name: plans.name,
      description: plans.description,
      active: plans.active,
      subUserLimit: plans.subUserLimit,
      metadata: plans.metadata,
    })
    .from(plans)
    .where(eq(plans.id, "PERSONAL"))
    .limit(1);

  if (!personal) {
    throw new AppError("PLAN_CONFIGURATION_MISSING", "The Personal plan is not configured.", 503);
  }
  return { ...personal, source: "DEFAULT" };
}

export async function getEffectiveWorkspaceSeatPlanInTransaction(tx: Tx, workspaceId: string) {
  const plan = await getWorkspacePlanInTransaction(tx, workspaceId);
  // Commercial entitlements follow the explicit purchaser, independent of
  // operational OWNER/ADMIN/STAFF roles. Fall back only for unreconciled
  // historical workspaces that still have exactly one OWNER membership.
  const [commercialOwner] = await tx.select({
    userId: workspaceCommercialOwners.purchaserUserId,
    kind: workspaceCommercialOwners.kind,
    createdAt: workspaceCommercialOwners.createdAt,
  })
    .from(workspaceCommercialOwners)
    .where(eq(workspaceCommercialOwners.workspaceId, workspaceId))
    .limit(1);
  // An Agency client keeps Core-only commercial seats even after an Agency
  // cancellation/refund. The prior purchase date classifies the client,
  // rather than whichever operational OWNER happens to be invited today.
  if (commercialOwner?.kind === "ADDITIONAL"
    && await wasProvisionedForAgency(commercialOwner.userId, commercialOwner.createdAt, tx)) {
    return { plan, commercialSeatPackage: null as "UNLIMITED" | null };
  }
  let purchaserUserId = commercialOwner?.userId ?? null;
  if (!purchaserUserId) {
    const owners = await tx.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "OWNER")))
      .limit(2);
    if (owners.length !== 1) return { plan, commercialSeatPackage: null as "UNLIMITED" | null };
    purchaserUserId = owners[0].userId;
  }
  const [unlimited] = await tx.select({ id: licenses.id }).from(licenses).where(and(
    eq(licenses.purchaserUserId, purchaserUserId),
    eq(licenses.productCode, "UNLIMITED"),
    eq(licenses.status, "ACTIVE"),
  )).limit(1);
  if (!unlimited) return { plan, commercialSeatPackage: null as "UNLIMITED" | null };
  return {
    plan: { ...plan, subUserLimit: Math.max(plan.subUserLimit, 5) },
    commercialSeatPackage: "UNLIMITED" as const,
  };
}

export async function getEffectiveWorkspaceSeatPlan(workspaceId: string) {
  return db.transaction((tx) => getEffectiveWorkspaceSeatPlanInTransaction(tx, workspaceId));
}

export async function getWorkspacePlan(workspaceId: string) {
  return db.transaction((tx) => getWorkspacePlanInTransaction(tx, workspaceId));
}

export async function getWorkspaceSeatUsage(workspaceId: string) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const { plan, commercialSeatPackage } = await getEffectiveWorkspaceSeatPlanInTransaction(tx, workspaceId);
    const [members, pending] = await Promise.all([
      activeSubUsers(tx, workspaceId),
      pendingInvitations(tx, workspaceId, now),
    ]);
    return {
      plan,
      commercialSeatPackage,
      activeSubUsers: members,
      pendingInvitations: pending,
      usedSeats: members + pending,
      availableSeats: Math.max(0, plan.subUserLimit - members - pending),
    };
  });
}

export async function assignWorkspacePlan(
  workspaceId: string,
  planId: PlanCode,
  source: string,
) {
  return db.transaction(async (tx) => {
    await lockPlanEntitlements(tx);
    await lockSeats(tx, workspaceId);
    const [target] = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (!target || !target.active) throw new AppError("PLAN_NOT_AVAILABLE", "That plan is not available.", 409);

    const now = new Date();
    const [members, pending] = await Promise.all([
      activeSubUsers(tx, workspaceId),
      pendingInvitations(tx, workspaceId, now),
    ]);
    const commercial = await getEffectiveWorkspaceSeatPlanInTransaction(tx, workspaceId);
    const effectiveTargetLimit = Math.max(target.subUserLimit, commercial.commercialSeatPackage === "UNLIMITED" ? 5 : 0);
    if (members + pending > effectiveTargetLimit) {
      throw new AppError(
        "PLAN_DOWNGRADE_BLOCKED",
        `Remove team members or pending invitations before moving this workspace to ${target.name}.`,
        409,
        { activeSubUsers: members, pendingInvitations: pending, subUserLimit: effectiveTargetLimit },
      );
    }

    const [assigned] = await tx.insert(workspacePlans).values({
      workspaceId,
      planId,
      source,
      assignedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: workspacePlans.workspaceId,
      set: { planId, source, updatedAt: now },
    }).returning();
    return assigned;
  });
}

export async function ensureWorkspacePlan(
  workspaceId: string,
  planId: PlanCode = "PERSONAL",
  source = "SYSTEM",
) {
  await db.insert(workspacePlans).values({
    workspaceId,
    planId,
    source,
  }).onConflictDoNothing();
}

async function activeSubUsers(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), ne(memberships.role, "OWNER")));
  return row?.count ?? 0;
}

async function pendingInvitations(tx: Tx, workspaceId: string, now: Date) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceInvitations)
    .where(and(
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.status, "PENDING"),
      ne(workspaceInvitations.role, "OWNER"),
      gt(workspaceInvitations.expiresAt, now),
    ));
  return row?.count ?? 0;
}

function seatLimitError(plan: { name: string; subUserLimit: number }) {
  const message = plan.subUserLimit === 0
    ? `${plan.name} does not include sub-users. Upgrade your offer or plan to invite team members.`
    : `${plan.name} supports up to ${plan.subUserLimit} sub-users. Remove a member or pending invitation before adding another.`;
  return new AppError("PLAN_SEAT_LIMIT", message, 403);
}

export async function assertCanCreateWorkspaceInvitation(tx: Tx, workspaceId: string) {
  await lockPlanEntitlements(tx);
  await lockSeats(tx, workspaceId);
  const now = new Date();
  const { plan, commercialSeatPackage } = await getEffectiveWorkspaceSeatPlanInTransaction(tx, workspaceId);
  if (!plan.active) throw new AppError("PLAN_INACTIVE", "This workspace plan is inactive.", 403);

  const [members, pending] = await Promise.all([
    activeSubUsers(tx, workspaceId),
    pendingInvitations(tx, workspaceId, now),
  ]);
  if (members + pending >= plan.subUserLimit) throw seatLimitError({
    ...plan,
    name: commercialSeatPackage === "UNLIMITED" ? "Unlimited" : plan.name,
  });
  return { plan, members, pending };
}

export async function assertCanAcceptWorkspaceInvitation(
  tx: Tx,
  workspaceId: string,
  userId: string,
) {
  await lockPlanEntitlements(tx);
  await lockSeats(tx, workspaceId);
  const [existing] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  if (existing) return;

  const { plan, commercialSeatPackage } = await getEffectiveWorkspaceSeatPlanInTransaction(tx, workspaceId);
  if (!plan.active) throw new AppError("PLAN_INACTIVE", "This workspace plan is inactive.", 403);
  const members = await activeSubUsers(tx, workspaceId);
  if (members >= plan.subUserLimit) throw seatLimitError({
    ...plan,
    name: commercialSeatPackage === "UNLIMITED" ? "Unlimited" : plan.name,
  });
}

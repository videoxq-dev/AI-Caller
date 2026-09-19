import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  adminAuditLogs,
  creditLedger,
  creditTopups,
  creditWallets,
  hostedApiRateCards,
  memberships,
  plans,
  platformAdmins,
  session,
  user,
  userAdminStates,
  usageEvents,
  workspaceInvitations,
  workspacePlans,
  workspaces,
} from "@/db/schema";
import { auth } from "@/server/auth";
import { getEnv } from "@/server/env";
import { isGuardedE2EFixtureMode } from "@/server/e2e-mode";
import { AppError } from "@/server/http/errors";
import { enqueueJob } from "@/server/jobs";
import { ADMIN_USER_WELCOME_EMAIL } from "@/server/jobs/queues";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function audit(
  tx: Tx,
  input: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
  },
) {
  const [row] = await tx.insert(adminAuditLogs).values({
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    details: input.details ?? {},
  }).returning();
  return row;
}

function boundedPage(limit = 50, offset = 0) {
  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
  const safeOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  return {
    limit: Math.min(Math.max(safeLimit, 1), 200),
    offset: Math.max(safeOffset, 0),
  };
}

export async function getAdminOverview() {
  const [users, workspaceRows, paidTopups, hostedUsage] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(user),
    db.select({ count: sql<number>`count(*)::int` }).from(workspaces),
    db.select({
      count: sql<number>`count(*)::int`,
      amountCents: sql<number>`coalesce(sum(greatest(${creditTopups.amountCents} - ${creditTopups.refundedAmountCents} - ${creditTopups.disputedAmountCents}, 0)), 0)::int`,
    }).from(creditTopups).where(isNotNull(creditTopups.paidAt)),
    db.select({
      credits: sql<number>`coalesce(sum(${usageEvents.creditsCharged}), 0)::int`,
      providerCostMicros: sql<number>`coalesce(sum(${usageEvents.providerCostMicros}), 0)::bigint`,
    }).from(usageEvents).where(eq(usageEvents.mode, "HOSTED")),
  ]);

  return {
    users: users[0]?.count ?? 0,
    workspaces: workspaceRows[0]?.count ?? 0,
    paidTopups: paidTopups[0]?.count ?? 0,
    topupRevenueCents: paidTopups[0]?.amountCents ?? 0,
    hostedCreditsCharged: hostedUsage[0]?.credits ?? 0,
    hostedProviderCostMicros: Number(hostedUsage[0]?.providerCostMicros ?? 0),
  };
}

export async function listAdminUsers(input: { limit?: number; offset?: number; search?: string }) {
  const { limit, offset } = boundedPage(input.limit, input.offset);
  const search = input.search?.trim();
  const where = search
    ? or(ilike(user.name, `%${search}%`), ilike(user.email, `%${search}%`))
    : undefined;

  const rows = await db.select({
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    status: userAdminStates.status,
    suspensionReason: userAdminStates.reason,
    platformAdminActive: platformAdmins.active,
    ownedWorkspaces: sql<number>`(
      select count(*)::int from memberships m
      where m.user_id = ${user.id} and m.role = 'OWNER'
    )`,
    workspaceMemberships: sql<number>`(
      select count(*)::int from memberships m
      where m.user_id = ${user.id}
    )`,
  })
    .from(user)
    .leftJoin(userAdminStates, eq(userAdminStates.userId, user.id))
    .leftJoin(platformAdmins, eq(platformAdmins.userId, user.id))
    .where(where)
    .orderBy(desc(user.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(user).where(where);
  const bootstrapEmails = new Set(
    getEnv().PLATFORM_ADMIN_EMAILS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  return {
    items: rows.map((row) => ({
      ...row,
      status: row.status ?? "ACTIVE",
      platformAdminActive: row.platformAdminActive ?? bootstrapEmails.has(row.email.trim().toLowerCase()),
    })),
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function createAdminUser(input: {
  actorUserId: string;
  name: string;
  email: string;
}) {
  const env = getEnv();
  if (!isGuardedE2EFixtureMode() && (!env.SMTP_URL || !env.SMTP_FROM)) {
    throw new AppError("ADMIN_USER_EMAIL_NOT_CONFIGURED", "Configure SMTP before creating users from Admin.", 409);
  }

  const email = input.email.trim().toLowerCase();
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existing) throw new AppError("USER_EXISTS", "A user with that email already exists.", 409);

  const temporaryPassword = randomBytes(18).toString("base64url");
  await auth.api.signUpEmail({
    body: { name: input.name.trim(), email, password: temporaryPassword },
  });
  const [created] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!created) throw new Error("Admin user creation did not persist the new user.");

  try {
    await enqueueJob(ADMIN_USER_WELCOME_EMAIL, {
      to: created.email,
      name: created.name,
      temporaryPassword,
      signInUrl: `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/sign-in`,
    });
  } catch (error) {
    // Better Auth provisions a default workspace in its user-create hook.
    // If the welcome message cannot be queued, remove the incomplete account and its owned default workspace
    // so an admin can retry creation without leaving an inaccessible user behind.
    await db.transaction(async (tx) => {
      const owned = await tx.select({ workspaceId: memberships.workspaceId })
        .from(memberships)
        .where(and(eq(memberships.userId, created.id), eq(memberships.role, "OWNER")));
      for (const membership of owned) {
        await tx.delete(workspaces).where(eq(workspaces.id, membership.workspaceId));
      }
      await tx.delete(user).where(eq(user.id, created.id));
    }).catch(() => undefined);
    throw error;
  }

  await db.transaction(async (tx) => {
    await audit(tx, {
      actorUserId: input.actorUserId,
      action: "USER_CREATED",
      targetType: "USER",
      targetId: created.id,
      details: { email: created.email },
    });
  });

  return {
    user: created,
    ...(isGuardedE2EFixtureMode() ? { e2eTemporaryPassword: temporaryPassword } : {}),
  };
}

export async function updateAdminUser(input: {
  actorUserId: string;
  userId: string;
  name?: string;
  email?: string;
  status?: "ACTIVE" | "SUSPENDED";
  suspensionReason?: string | null;
  platformAdmin?: boolean;
}) {
  if (input.userId === input.actorUserId && input.status === "SUSPENDED") {
    throw new AppError("ADMIN_SELF_SUSPEND_BLOCKED", "You cannot suspend your own admin account.", 409);
  }
  if (input.userId === input.actorUserId && input.platformAdmin === false) {
    throw new AppError("ADMIN_SELF_REVOKE_BLOCKED", "You cannot revoke your own platform admin access.", 409);
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(user).where(eq(user.id, input.userId)).limit(1);
    if (!existing) throw new AppError("USER_NOT_FOUND", "User not found.", 404);

    const patch: Partial<typeof user.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      const [conflict] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
      if (conflict && conflict.id !== input.userId) {
        throw new AppError("USER_EXISTS", "A user with that email already exists.", 409);
      }
      patch.email = email;
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = new Date();
      await tx.update(user).set(patch).where(eq(user.id, input.userId));
    }

    if (input.status !== undefined) {
      await tx.insert(userAdminStates).values({
        userId: input.userId,
        status: input.status,
        reason: input.status === "SUSPENDED" ? input.suspensionReason?.trim() || null : null,
        updatedByUserId: input.actorUserId,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: userAdminStates.userId,
        set: {
          status: input.status,
          reason: input.status === "SUSPENDED" ? input.suspensionReason?.trim() || null : null,
          updatedByUserId: input.actorUserId,
          updatedAt: new Date(),
        },
      });
      if (input.status === "SUSPENDED") {
        await tx.delete(session).where(eq(session.userId, input.userId));
      }
    }

    if (input.platformAdmin !== undefined) {
      await tx.insert(platformAdmins).values({
        userId: input.userId,
        role: "ADMIN",
        active: input.platformAdmin,
        createdByUserId: input.actorUserId,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: platformAdmins.userId,
        set: {
          active: input.platformAdmin,
          updatedAt: new Date(),
        },
      });
    }

    await audit(tx, {
      actorUserId: input.actorUserId,
      action: "USER_UPDATED",
      targetType: "USER",
      targetId: input.userId,
      details: {
        nameChanged: input.name !== undefined,
        emailChanged: input.email !== undefined,
        status: input.status,
        platformAdmin: input.platformAdmin,
      },
    });

    const [updated] = await tx.select().from(user).where(eq(user.id, input.userId)).limit(1);
    return updated;
  });
}

export async function deleteAdminUser(input: {
  actorUserId: string;
  userId: string;
  deleteOwnedWorkspaces: boolean;
}) {
  if (input.actorUserId === input.userId) {
    throw new AppError("ADMIN_SELF_DELETE_BLOCKED", "You cannot delete your own admin account.", 409);
  }

  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(user).where(eq(user.id, input.userId)).limit(1);
    if (!target) throw new AppError("USER_NOT_FOUND", "User not found.", 404);

    const owned = await tx.select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(and(eq(memberships.userId, input.userId), eq(memberships.role, "OWNER")));

    if (owned.length && !input.deleteOwnedWorkspaces) {
      throw new AppError(
        "USER_OWNS_WORKSPACES",
        "This user owns workspaces. Explicitly delete or transfer those workspaces before deleting the user.",
        409,
        { ownedWorkspaceCount: owned.length },
      );
    }

    for (const membership of owned) {
      await tx.delete(workspaces).where(eq(workspaces.id, membership.workspaceId));
    }

    await audit(tx, {
      actorUserId: input.actorUserId,
      action: "USER_DELETED",
      targetType: "USER",
      targetId: input.userId,
      details: { email: target.email, deletedOwnedWorkspaces: owned.length },
    });
    await tx.delete(user).where(eq(user.id, input.userId));
    return { id: input.userId, deletedOwnedWorkspaces: owned.length };
  });
}

export async function listAdminWorkspaces(input: { limit?: number; offset?: number; search?: string }) {
  const { limit, offset } = boundedPage(input.limit, input.offset);
  const search = input.search?.trim();
  const where = search ? ilike(workspaces.name, `%${search}%`) : undefined;

  const rows = await db.select({
    id: workspaces.id,
    name: workspaces.name,
    status: workspaces.status,
    createdAt: workspaces.createdAt,
    planId: workspacePlans.planId,
    planName: plans.name,
    creditBalance: creditWallets.balance,
    memberCount: sql<number>`(
      select count(*)::int from memberships m where m.workspace_id = ${workspaces.id}
    )`,
    pendingInvitations: sql<number>`(
      select count(*)::int from workspace_invitations wi
      where wi.workspace_id = ${workspaces.id}
        and wi.status = 'PENDING'
        and wi.expires_at > now()
    )`,
  })
    .from(workspaces)
    .leftJoin(workspacePlans, eq(workspacePlans.workspaceId, workspaces.id))
    .leftJoin(plans, eq(plans.id, workspacePlans.planId))
    .leftJoin(creditWallets, eq(creditWallets.workspaceId, workspaces.id))
    .where(where)
    .orderBy(desc(workspaces.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(workspaces).where(where);
  return {
    items: rows.map((row) => ({
      ...row,
      planId: row.planId ?? "PERSONAL",
      planName: row.planName ?? "Personal",
      creditBalance: row.creditBalance ?? 0,
    })),
    total: count ?? 0,
    limit,
    offset,
  };
}

async function assignPlanInTx(
  tx: Tx,
  workspaceId: string,
  planId: "PERSONAL" | "GROWTH",
  source: string,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('plan-entitlements'))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan-seat:${workspaceId}`}))`);
  const [target] = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!target || !target.active) throw new AppError("PLAN_NOT_AVAILABLE", "That plan is not available.", 409);

  const [seatUsage] = await tx.select({
    active: sql<number>`(select count(*)::int from memberships m where m.workspace_id = ${workspaceId} and m.role <> 'OWNER')`,
    pending: sql<number>`(select count(*)::int from workspace_invitations wi where wi.workspace_id = ${workspaceId} and wi.status = 'PENDING' and wi.expires_at > now())`,
  }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const used = (seatUsage?.active ?? 0) + (seatUsage?.pending ?? 0);
  if (used > target.subUserLimit) {
    throw new AppError("PLAN_DOWNGRADE_BLOCKED", "Remove team members or pending invitations before changing to this plan.", 409, {
      usedSeats: used,
      subUserLimit: target.subUserLimit,
    });
  }

  await tx.insert(workspacePlans).values({
    workspaceId,
    planId,
    source,
  }).onConflictDoUpdate({
    target: workspacePlans.workspaceId,
    set: { planId, source, updatedAt: new Date() },
  });
}

export async function updateAdminWorkspace(input: {
  actorUserId: string;
  workspaceId: string;
  status?: "ACTIVE" | "SUSPENDED";
  planId?: "PERSONAL" | "GROWTH";
}) {
  return db.transaction(async (tx) => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "Workspace not found.", 404);

    if (input.planId) await assignPlanInTx(tx, input.workspaceId, input.planId, "ADMIN");
    if (input.status) {
      await tx.update(workspaces).set({ status: input.status, updatedAt: new Date() })
        .where(eq(workspaces.id, input.workspaceId));
    }

    await audit(tx, {
      actorUserId: input.actorUserId,
      action: "WORKSPACE_UPDATED",
      targetType: "WORKSPACE",
      targetId: input.workspaceId,
      details: { planId: input.planId, status: input.status },
    });
  });
}

export async function adjustWorkspaceCredits(input: {
  actorUserId: string;
  workspaceId: string;
  amount: number;
  reason: string;
}) {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new AppError("INVALID_CREDIT_ADJUSTMENT", "Credit adjustment must be a non-zero integer.", 400);
  }
  const reason = input.reason.trim();
  if (reason.length < 3) throw new AppError("ADJUSTMENT_REASON_REQUIRED", "A reason is required for credit adjustments.", 400);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit-wallet:${input.workspaceId}`}))`);
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces)
      .where(eq(workspaces.id, input.workspaceId)).limit(1);
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "Workspace not found.", 404);

    await tx.insert(creditWallets).values({ workspaceId: input.workspaceId, balance: 0 }).onConflictDoNothing();
    const auditRow = await audit(tx, {
      actorUserId: input.actorUserId,
      action: "CREDITS_ADJUSTED",
      targetType: "WORKSPACE",
      targetId: input.workspaceId,
      details: { amount: input.amount, reason },
    });
    const [wallet] = await tx.update(creditWallets).set({
      balance: sql`${creditWallets.balance} + ${input.amount}`,
      updatedAt: new Date(),
    }).where(eq(creditWallets.workspaceId, input.workspaceId)).returning({ balance: creditWallets.balance });

    await tx.insert(creditLedger).values({
      workspaceId: input.workspaceId,
      type: "ADJUSTMENT",
      amount: input.amount,
      balanceAfter: wallet.balance,
      reason: `Admin adjustment: ${reason}`,
      referenceType: "ADMIN_AUDIT",
      referenceId: auditRow.id,
    });
    return { balance: wallet.balance };
  });
}

export async function listAdminPlans() {
  return db.select().from(plans).orderBy(asc(plans.name));
}

export async function updateAdminPlan(input: {
  actorUserId: string;
  planId: "PERSONAL" | "GROWTH";
  name?: string;
  description?: string | null;
  active?: boolean;
  subUserLimit?: number;
}) {
  if (input.subUserLimit !== undefined && (!Number.isInteger(input.subUserLimit) || input.subUserLimit < 0 || input.subUserLimit > 100)) {
    throw new AppError("INVALID_PLAN_LIMIT", "Sub-user limit must be an integer between 0 and 100.", 400);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('plan-entitlements'))`);
    const [plan] = await tx.select().from(plans).where(eq(plans.id, input.planId)).limit(1);
    if (!plan) throw new AppError("PLAN_NOT_FOUND", "Plan not found.", 404);

    if (input.active === false) {
      const [assigned] = await tx.select({ workspaceId: workspacePlans.workspaceId }).from(workspacePlans)
        .where(eq(workspacePlans.planId, input.planId)).limit(1);
      if (assigned) throw new AppError("PLAN_IN_USE", "A plan assigned to workspaces cannot be deactivated.", 409);
    }

    if (input.subUserLimit !== undefined && input.subUserLimit < plan.subUserLimit) {
      const [violating] = await tx.select({ workspaceId: workspacePlans.workspaceId })
        .from(workspacePlans)
        .where(and(
          eq(workspacePlans.planId, input.planId),
          sql`(
            (select count(*) from memberships m where m.workspace_id = ${workspacePlans.workspaceId} and m.role <> 'OWNER') +
            (select count(*) from workspace_invitations wi where wi.workspace_id = ${workspacePlans.workspaceId} and wi.status = 'PENDING' and wi.expires_at > now())
          ) > ${input.subUserLimit}`,
        ))
        .limit(1);
      if (violating) throw new AppError("PLAN_LIMIT_IN_USE", "Existing workspaces exceed the requested sub-user limit.", 409);
    }

    const patch: Partial<typeof plans.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.active !== undefined) patch.active = input.active;
    if (input.subUserLimit !== undefined) patch.subUserLimit = input.subUserLimit;

    const [updated] = await tx.update(plans).set(patch).where(eq(plans.id, input.planId)).returning();
    await audit(tx, {
      actorUserId: input.actorUserId,
      action: "PLAN_UPDATED",
      targetType: "PLAN",
      targetId: input.planId,
      details: { active: input.active, subUserLimit: input.subUserLimit },
    });
    return updated;
  });
}

export async function listAdminRateCards() {
  return db.select().from(hostedApiRateCards)
    .orderBy(desc(hostedApiRateCards.effectiveFrom), asc(hostedApiRateCards.capability), asc(hostedApiRateCards.provider))
    .limit(500);
}

export async function createAdminRateVersion(input: {
  actorUserId: string;
  capability: "AI_TEXT" | "SMS" | "VOICE";
  provider: string;
  model?: string;
  unit: "AI_INPUT_TOKEN" | "AI_CACHED_INPUT_TOKEN" | "AI_OUTPUT_TOKEN" | "SMS_SEGMENT" | "VOICE_MINUTE";
  costMicros: number;
  unitsPerCost: number;
  targetMarginBps: number;
  effectiveFrom: Date;
}) {
  if (!Number.isSafeInteger(input.costMicros) || input.costMicros < 0) throw new AppError("INVALID_RATE_COST", "Provider cost must be a non-negative integer micro-USD value.", 400);
  if (!Number.isInteger(input.unitsPerCost) || input.unitsPerCost <= 0) throw new AppError("INVALID_RATE_UNITS", "Units per cost must be a positive integer.", 400);
  if (!Number.isInteger(input.targetMarginBps) || input.targetMarginBps < 0 || input.targetMarginBps > 9500) throw new AppError("INVALID_RATE_MARGIN", "Target margin must be between 0 and 9500 basis points.", 400);
  if (input.capability === "SMS" && input.unit !== "SMS_SEGMENT") throw new AppError("INVALID_RATE_UNIT", "SMS rates must use SMS_SEGMENT.", 400);
  if (input.capability === "VOICE" && input.unit !== "VOICE_MINUTE") throw new AppError("INVALID_RATE_UNIT", "Voice rates must use VOICE_MINUTE.", 400);
  if (input.capability === "AI_TEXT" && (input.unit === "SMS_SEGMENT" || input.unit === "VOICE_MINUTE")) throw new AppError("INVALID_RATE_UNIT", "AI rates must use an AI token unit.", 400);
  if (Number.isNaN(input.effectiveFrom.getTime())) throw new AppError("INVALID_RATE_DATE", "Rate effective date is invalid.", 400);

  const provider = input.provider.trim().toLowerCase();
  const model = input.model?.trim() ?? "";

  return db.transaction(async (tx) => {
    const key = `${input.capability}:${provider}:${model}:${input.unit}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hosted-rate:${key}`}))`);

    const [duplicate] = await tx.select({ id: hostedApiRateCards.id }).from(hostedApiRateCards).where(and(
      eq(hostedApiRateCards.capability, input.capability),
      eq(hostedApiRateCards.provider, provider),
      eq(hostedApiRateCards.model, model),
      eq(hostedApiRateCards.unit, input.unit),
      eq(hostedApiRateCards.effectiveFrom, input.effectiveFrom),
    )).limit(1);
    if (duplicate) throw new AppError("RATE_VERSION_EXISTS", "A rate version already exists at that effective time.", 409);

    const [next] = await tx.select({ effectiveFrom: hostedApiRateCards.effectiveFrom }).from(hostedApiRateCards).where(and(
      eq(hostedApiRateCards.capability, input.capability),
      eq(hostedApiRateCards.provider, provider),
      eq(hostedApiRateCards.model, model),
      eq(hostedApiRateCards.unit, input.unit),
      gt(hostedApiRateCards.effectiveFrom, input.effectiveFrom),
    )).orderBy(asc(hostedApiRateCards.effectiveFrom)).limit(1);

    await tx.update(hostedApiRateCards).set({
      effectiveTo: input.effectiveFrom,
      updatedAt: new Date(),
    }).where(and(
      eq(hostedApiRateCards.capability, input.capability),
      eq(hostedApiRateCards.provider, provider),
      eq(hostedApiRateCards.model, model),
      eq(hostedApiRateCards.unit, input.unit),
      sql`${hostedApiRateCards.effectiveFrom} < ${input.effectiveFrom}`,
      or(isNull(hostedApiRateCards.effectiveTo), gt(hostedApiRateCards.effectiveTo, input.effectiveFrom)),
    ));

    const [created] = await tx.insert(hostedApiRateCards).values({
      capability: input.capability,
      provider,
      model,
      unit: input.unit,
      costMicros: input.costMicros,
      unitsPerCost: input.unitsPerCost,
      targetMarginBps: input.targetMarginBps,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: next?.effectiveFrom ?? null,
      metadata: { currency: "USD", createdByAdmin: input.actorUserId },
    }).returning();

    await audit(tx, {
      actorUserId: input.actorUserId,
      action: "HOSTED_RATE_VERSION_CREATED",
      targetType: "HOSTED_RATE",
      targetId: created.id,
      details: {
        capability: input.capability,
        provider,
        model,
        unit: input.unit,
        costMicros: input.costMicros,
        unitsPerCost: input.unitsPerCost,
        targetMarginBps: input.targetMarginBps,
        effectiveFrom: input.effectiveFrom.toISOString(),
      },
    });
    return created;
  });
}

export async function setAdminRateEnabled(input: {
  actorUserId: string;
  rateId: string;
  enabled: boolean;
}) {
  return db.transaction(async (tx) => {
    const [rate] = await tx.update(hostedApiRateCards).set({
      enabled: input.enabled,
      updatedAt: new Date(),
    }).where(eq(hostedApiRateCards.id, input.rateId)).returning();
    if (!rate) throw new AppError("RATE_NOT_FOUND", "Hosted API rate not found.", 404);
    await audit(tx, {
      actorUserId: input.actorUserId,
      action: "HOSTED_RATE_STATUS_CHANGED",
      targetType: "HOSTED_RATE",
      targetId: rate.id,
      details: { enabled: input.enabled },
    });
    return rate;
  });
}

export async function listAdminAuditLogs(limit = 100) {
  return db.select({
    id: adminAuditLogs.id,
    actorUserId: adminAuditLogs.actorUserId,
    actorEmail: user.email,
    action: adminAuditLogs.action,
    targetType: adminAuditLogs.targetType,
    targetId: adminAuditLogs.targetId,
    details: adminAuditLogs.details,
    createdAt: adminAuditLogs.createdAt,
  })
    .from(adminAuditLogs)
    .leftJoin(user, eq(user.id, adminAuditLogs.actorUserId))
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

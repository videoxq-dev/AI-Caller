import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getFunnelAccountSummary } from "@/server/commerce/account-licenses";
import { db } from "@/db";
import { licenses, memberships, user, workspaceCommercialOwners, workspacePlans, workspaces } from "@/db/schema";
import { getAgencyClientLimit, getPurchasedBusinessLimit } from "@/server/commerce/products";
import { AppError } from "@/server/http/errors";

type WorkspaceUser = {
  id: string;
  name: string;
  email: string;
};

export type WorkspaceMembership = {
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: "ACTIVE" | "SUSPENDED";
  role: "OWNER" | "ADMIN" | "STAFF";
};

export type CommercialWorkspace = {
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: "ACTIVE" | "SUSPENDED";
  kind: "PRIMARY" | "ADDITIONAL";
};

export async function getMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
  const [row] = await db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceStatus: workspaces.status,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
    .limit(1);

  return row ?? null;
}

export async function listMembershipsForUser(userId: string): Promise<WorkspaceMembership[]> {
  return db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceStatus: workspaces.status,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt));
}

export async function listCommercialWorkspacesForUser(userId: string): Promise<CommercialWorkspace[]> {
  return db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceStatus: workspaces.status,
      kind: workspaceCommercialOwners.kind,
    })
    .from(workspaceCommercialOwners)
    .innerJoin(workspaces, eq(workspaceCommercialOwners.workspaceId, workspaces.id))
    .where(eq(workspaceCommercialOwners.purchaserUserId, userId))
    .orderBy(sql`case when ${workspaceCommercialOwners.kind} = 'PRIMARY' then 0 else 1 end`, asc(workspaceCommercialOwners.createdAt), asc(workspaces.createdAt), asc(workspaces.id));
}

export async function listWorkspaceMembers(workspaceId: string) {
  return db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(user, eq(memberships.userId, user.id))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(memberships.createdAt));
}

export async function getPrimaryOwnedWorkspace(userId: string): Promise<WorkspaceMembership | null> {
  const [commercial] = await db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceStatus: workspaces.status,
      role: memberships.role,
    })
    .from(workspaceCommercialOwners)
    .innerJoin(workspaces, eq(workspaceCommercialOwners.workspaceId, workspaces.id))
    .innerJoin(memberships, and(
      eq(memberships.workspaceId, workspaceCommercialOwners.workspaceId),
      eq(memberships.userId, userId),
    ))
    .where(and(
      eq(workspaceCommercialOwners.purchaserUserId, userId),
      eq(workspaceCommercialOwners.kind, "PRIMARY"),
    ))
    .orderBy(asc(workspaceCommercialOwners.createdAt), asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  if (commercial) return commercial;

  // Legacy fallback for deliberately unreconciled historical co-owned workspaces.
  const [legacy] = await db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceStatus: workspaces.status,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .leftJoin(workspaceCommercialOwners, eq(workspaceCommercialOwners.workspaceId, workspaces.id))
    .where(and(
      eq(memberships.userId, userId),
      eq(memberships.role, "OWNER"),
      isNull(workspaceCommercialOwners.workspaceId),
    ))
    .orderBy(asc(memberships.createdAt), asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return legacy ?? null;
}

export async function getPrimaryMembership(userId: string): Promise<WorkspaceMembership | null> {
  const [row] = await db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceStatus: workspaces.status,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt))
    .limit(1);

  return row ?? null;
}

export async function ensureDefaultWorkspace(user: WorkspaceUser): Promise<WorkspaceMembership> {
  const existing = await getPrimaryMembership(user.id);
  if (existing) return existing;

  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select({
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        workspaceStatus: workspaces.status,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, user.id))
      .orderBy(asc(memberships.createdAt))
      .limit(1);

    if (membership) return membership;

    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: user.name.trim() ? `${user.name.trim()}'s Business` : "My Business" })
      .returning({ id: workspaces.id, name: workspaces.name, status: workspaces.status });

    await tx.insert(memberships).values({
      workspaceId: workspace.id,
      userId: user.id,
      role: "OWNER",
    });
    await tx.insert(workspaceCommercialOwners).values({
      workspaceId: workspace.id,
      purchaserUserId: user.id,
      kind: "PRIMARY",
    });
    await tx.insert(workspacePlans).values({
      workspaceId: workspace.id,
      planId: "PERSONAL",
      source: "DEFAULT",
    }).onConflictDoNothing();

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceStatus: workspace.status,
      role: "OWNER",
    };
  });
}

export async function getOwnedWorkspaceCapacity(userId: string) {
  const [summary, commercial, legacy] = await Promise.all([
    getFunnelAccountSummary(userId),
    db.select({ count: sql<number>`count(*)::int` })
      .from(workspaceCommercialOwners)
      .where(eq(workspaceCommercialOwners.purchaserUserId, userId)),
    db.select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .leftJoin(workspaceCommercialOwners, eq(workspaceCommercialOwners.workspaceId, memberships.workspaceId))
      .where(and(
        eq(memberships.userId, userId),
        eq(memberships.role, "OWNER"),
        isNull(workspaceCommercialOwners.workspaceId),
      )),
  ]);
  const ownedBusinesses = (commercial[0]?.count ?? 0) + (legacy[0]?.count ?? 0);
  const businessLimit = Math.max(1, summary.businessLimit);
  const agencyClientLimit = getAgencyClientLimit(summary.activeProducts);
  const agencyClientsUsed = Math.max(0, ownedBusinesses - 1);
  return {
    ownedBusinesses,
    businessLimit,
    availableBusinesses: Math.max(0, businessLimit - ownedBusinesses),
    agencyClientLimit,
    agencyClientsUsed: agencyClientLimit === null ? null : agencyClientsUsed,
    agencyClientsAvailable: agencyClientLimit === null ? null : Math.max(0, agencyClientLimit - agencyClientsUsed),
    activeProducts: summary.activeProducts,
  };
}

export async function createWorkspaceForUser(userId: string, name: string): Promise<WorkspaceMembership> {
  const workspaceName = name.trim();
  return db.transaction(async (tx) => {
    // Lock first, count and create in the SAME transaction. Independent API
    // requests cannot consume the last account business slot concurrently.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`funnel-business-capacity:${userId}`}))`);
    const [commercialUsage] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(workspaceCommercialOwners)
      .where(eq(workspaceCommercialOwners.purchaserUserId, userId));
    const [legacyUsage] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .leftJoin(workspaceCommercialOwners, eq(workspaceCommercialOwners.workspaceId, memberships.workspaceId))
      .where(and(
        eq(memberships.userId, userId),
        eq(memberships.role, "OWNER"),
        isNull(workspaceCommercialOwners.workspaceId),
      ));
    const ownedBusinesses = (commercialUsage?.count ?? 0) + (legacyUsage?.count ?? 0);
    const activePurchases = await tx.selectDistinct({ code: licenses.productCode })
      .from(licenses)
      .where(and(eq(licenses.purchaserUserId, userId), eq(licenses.status, "ACTIVE")));
    const purchasedCapacity = getPurchasedBusinessLimit(activePurchases.map(({ code }) => code));
    // A buyer can set up the initial business before checkout. Existing older
    // workspaces remain intact, but extra creation requires purchased capacity.
    const limit = Math.max(1, purchasedCapacity);
    if (ownedBusinesses >= limit) {
      throw new AppError(
        "WORKSPACE_LIMIT_REACHED",
        "You have reached the number of businesses included with your purchase.",
        403,
        { ownedBusinesses, businessLimit: limit },
      );
    }

    const [workspace] = await tx.insert(workspaces).values({ name: workspaceName })
      .returning({ id: workspaces.id, name: workspaces.name, status: workspaces.status });
    await tx.insert(memberships).values({
      workspaceId: workspace.id,
      userId,
      role: "OWNER",
    });
    await tx.insert(workspaceCommercialOwners).values({
      workspaceId: workspace.id,
      purchaserUserId: userId,
      kind: ownedBusinesses === 0 ? "PRIMARY" : "ADDITIONAL",
    });
    await tx.insert(workspacePlans).values({
      workspaceId: workspace.id,
      planId: "PERSONAL",
      source: "DEFAULT",
    });
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceStatus: workspace.status,
      role: "OWNER" as const,
    };
  });
}

import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationSettings, conversations, leads, licenses, memberships, user, workspaceCommercialOwners, workspaceInvitations } from "@/db/schema";
import {
  assertCanAcceptWorkspaceInvitation,
  assertCanCreateWorkspaceInvitation,
} from "@/server/billing/plans";
import { AppError } from "@/server/http/errors";

export type InviteRole = "OWNER" | "ADMIN" | "STAFF";
export type SubUserRole = Exclude<InviteRole, "OWNER">;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: string }).code === "23505") return true;
  return "cause" in error && isUniqueViolation((error as { cause?: unknown }).cause);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockAgencyClientOwner(tx: Tx, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agency-client-owner:${workspaceId}`}))`);
}

async function requireActiveAgencyClientWorkspace(
  tx: Tx,
  workspaceId: string,
  actorUserId?: string,
) {
  const [commercial] = await tx.select({
    purchaserUserId: workspaceCommercialOwners.purchaserUserId,
    kind: workspaceCommercialOwners.kind,
  }).from(workspaceCommercialOwners)
    .where(eq(workspaceCommercialOwners.workspaceId, workspaceId))
    .limit(1);

  if (!commercial || commercial.kind !== "ADDITIONAL") {
    throw new AppError(
      "AGENCY_CLIENT_WORKSPACE_REQUIRED",
      "Client-owner access is available only for an Agency-managed client workspace.",
      403,
    );
  }
  if (actorUserId && commercial.purchaserUserId !== actorUserId) {
    throw new AppError(
      "AGENCY_COMMERCIAL_OWNER_REQUIRED",
      "Only the Agency commercial owner can invite a client owner.",
      403,
    );
  }

  const [agency] = await tx.select({ id: licenses.id }).from(licenses).where(and(
    eq(licenses.purchaserUserId, commercial.purchaserUserId),
    eq(licenses.status, "ACTIVE"),
    sql`${licenses.productCode} in ('AGENCY_50', 'AGENCY_100')`,
  )).limit(1);
  if (!agency) {
    throw new AppError("AGENCY_REQUIRED", "An active Agency package is required.", 403);
  }
  return commercial;
}

async function assertCanCreateClientOwnerInvitation(
  tx: Tx,
  workspaceId: string,
  actorUserId: string,
  now: Date,
) {
  await lockAgencyClientOwner(tx, workspaceId);
  const commercial = await requireActiveAgencyClientWorkspace(tx, workspaceId, actorUserId);
  const [delegatedOwner] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(
    eq(memberships.workspaceId, workspaceId),
    eq(memberships.role, "OWNER"),
    sql`${memberships.userId} <> ${commercial.purchaserUserId}`,
  )).limit(1);
  if (delegatedOwner) {
    throw new AppError("CLIENT_OWNER_EXISTS", "This client workspace already has a delegated client owner.", 409);
  }

  const [pendingOwner] = await tx.select({ id: workspaceInvitations.id }).from(workspaceInvitations).where(and(
    eq(workspaceInvitations.workspaceId, workspaceId),
    eq(workspaceInvitations.role, "OWNER"),
    eq(workspaceInvitations.status, "PENDING"),
    gt(workspaceInvitations.expiresAt, now),
  )).limit(1);
  if (pendingOwner) {
    throw new AppError(
      "CLIENT_OWNER_INVITATION_EXISTS",
      "A client-owner invitation is already pending for this workspace.",
      409,
    );
  }
}

async function assertCanAcceptClientOwnerInvitation(tx: Tx, workspaceId: string) {
  await lockAgencyClientOwner(tx, workspaceId);
  const commercial = await requireActiveAgencyClientWorkspace(tx, workspaceId);
  const [delegatedOwner] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(
    eq(memberships.workspaceId, workspaceId),
    eq(memberships.role, "OWNER"),
    sql`${memberships.userId} <> ${commercial.purchaserUserId}`,
  )).limit(1);
  if (delegatedOwner) {
    throw new AppError("CLIENT_OWNER_EXISTS", "This client workspace already has a delegated client owner.", 409);
  }
}

export async function listWorkspaceTeam(workspaceId: string) {
  const now = new Date();
  await db.update(workspaceInvitations)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(and(
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.status, "PENDING"),
      lte(workspaceInvitations.expiresAt, now),
    ));

  const [members, invitations] = await Promise.all([
    db.select({
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
      .orderBy(asc(memberships.createdAt)),
    db.select({
      id: workspaceInvitations.id,
      email: workspaceInvitations.email,
      role: workspaceInvitations.role,
      status: workspaceInvitations.status,
      expiresAt: workspaceInvitations.expiresAt,
      createdAt: workspaceInvitations.createdAt,
      invitedByUserId: workspaceInvitations.invitedByUserId,
    })
      .from(workspaceInvitations)
      .where(and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.status, "PENDING"),
        gt(workspaceInvitations.expiresAt, now),
      ))
      .orderBy(asc(workspaceInvitations.createdAt)),
  ]);

  return { members, invitations };
}

export async function createWorkspaceInvitation(input: {
  workspaceId: string;
  invitedByUserId: string;
  email: string;
  role: InviteRole;
}) {
  const email = normalizeEmail(input.email);
  const token = randomBytes(32).toString("base64url");

  try {
    return await db.transaction(async (tx) => {
      const existingMember = await tx.select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(user, eq(memberships.userId, user.id))
        .where(and(eq(memberships.workspaceId, input.workspaceId), sql`lower(${user.email}) = ${email}`))
        .limit(1);
      if (existingMember.length) {
        throw new AppError("ALREADY_MEMBER", "That email already belongs to this workspace.", 409);
      }

      const now = new Date();
      await tx.update(workspaceInvitations)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(and(
          eq(workspaceInvitations.workspaceId, input.workspaceId),
          eq(workspaceInvitations.status, "PENDING"),
          lte(workspaceInvitations.expiresAt, now),
        ));

      if (input.role === "OWNER") {
        await assertCanCreateClientOwnerInvitation(tx, input.workspaceId, input.invitedByUserId, now);
      } else {
        await assertCanCreateWorkspaceInvitation(tx, input.workspaceId);
      }

      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const [invitation] = await tx.insert(workspaceInvitations).values({
        workspaceId: input.workspaceId,
        email,
        role: input.role,
        tokenHash: tokenHash(token),
        invitedByUserId: input.invitedByUserId,
        expiresAt,
      }).returning({
        id: workspaceInvitations.id,
        email: workspaceInvitations.email,
        role: workspaceInvitations.role,
        expiresAt: workspaceInvitations.expiresAt,
      });
      return { invitation, token };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("INVITATION_EXISTS", "A pending invitation already exists for that email.", 409);
    }
    throw error;
  }
}

export async function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
  actorRole: "OWNER" | "ADMIN",
) {
  return db.transaction(async (tx) => {
    const [pending] = await tx.select({
      id: workspaceInvitations.id,
      role: workspaceInvitations.role,
    }).from(workspaceInvitations).where(and(
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.id, invitationId),
      eq(workspaceInvitations.status, "PENDING"),
    )).limit(1);
    if (!pending) throw new AppError("INVITATION_NOT_FOUND", "Pending invitation not found.", 404);
    if (actorRole === "ADMIN" && pending.role !== "STAFF") {
      throw new AppError(
        "FORBIDDEN_ROLE_ASSIGNMENT",
        "Only a workspace owner can manage Admin or client-owner invitations.",
        403,
      );
    }

    const [invitation] = await tx.update(workspaceInvitations)
      .set({ status: "REVOKED", updatedAt: new Date() })
      .where(and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.id, invitationId),
        eq(workspaceInvitations.status, "PENDING"),
      ))
      .returning({ id: workspaceInvitations.id });
    if (!invitation) throw new AppError("INVITATION_NOT_FOUND", "Pending invitation not found.", 404);
    return invitation;
  });
}

export async function acceptWorkspaceInvitation(input: { userId: string; userEmail: string; token: string }) {
  const hash = tokenHash(input.token);
  const now = new Date();
  return db.transaction(async (tx) => {
    const [invitation] = await tx.select().from(workspaceInvitations).where(and(
      eq(workspaceInvitations.tokenHash, hash),
      eq(workspaceInvitations.status, "PENDING"),
      gt(workspaceInvitations.expiresAt, now),
    )).limit(1);

    if (!invitation) throw new AppError("INVITATION_INVALID", "This invitation is invalid or has expired.", 400);
    if (invitation.email !== normalizeEmail(input.userEmail)) {
      throw new AppError("INVITATION_EMAIL_MISMATCH", "Sign in with the email address that was invited.", 403);
    }

    if (invitation.role === "OWNER") {
      await assertCanAcceptClientOwnerInvitation(tx, invitation.workspaceId);
    } else {
      await assertCanAcceptWorkspaceInvitation(tx, invitation.workspaceId, input.userId);
    }

    await tx.insert(memberships).values({
      workspaceId: invitation.workspaceId,
      userId: input.userId,
      role: invitation.role,
    }).onConflictDoNothing();

    const [accepted] = await tx.update(workspaceInvitations).set({
      status: "ACCEPTED",
      acceptedAt: now,
      updatedAt: now,
    }).where(and(
      eq(workspaceInvitations.id, invitation.id),
      eq(workspaceInvitations.status, "PENDING"),
    )).returning({ id: workspaceInvitations.id });

    if (!accepted) throw new AppError("INVITATION_ALREADY_USED", "This invitation has already been used.", 409);
    return { workspaceId: invitation.workspaceId, role: invitation.role };
  });
}

export async function updateWorkspaceMemberRole(workspaceId: string, userId: string, role: SubUserRole) {
  const [member] = await db.update(memberships).set({ role })
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .returning({ userId: memberships.userId, role: memberships.role });
  if (!member) throw new AppError("MEMBER_NOT_FOUND", "Workspace member not found.", 404);
  return member;
}

export async function removeWorkspaceMember(workspaceId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [member] = await tx.delete(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId, role: memberships.role });
    if (!member) throw new AppError("MEMBER_NOT_FOUND", "Workspace member not found.", 404);

    await tx.update(conversations).set({ assignedUserId: null, updatedAt: new Date() }).where(and(
      eq(conversations.workspaceId, workspaceId),
      eq(conversations.assignedUserId, userId),
    ));
    await tx.update(leads).set({ assignedUserId: null, updatedAt: new Date() }).where(and(
      eq(leads.workspaceId, workspaceId),
      eq(leads.assignedUserId, userId),
    ));

    const assignmentSettings = await tx.select().from(automationSettings).where(and(
      eq(automationSettings.workspaceId, workspaceId),
      sql`${automationSettings.key} in ('QUALIFIED_LEAD_ASSIGNMENT', 'HUMAN_ESCALATION')`,
    ));
    for (const setting of assignmentSettings) {
      if (setting.config.assignedUserId !== userId) continue;
      await tx.update(automationSettings).set({
        config: { ...setting.config, assignedUserId: null },
        updatedAt: new Date(),
      }).where(eq(automationSettings.id, setting.id));
    }
    return member;
  });
}

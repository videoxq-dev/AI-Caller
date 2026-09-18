import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, user, workspaceInvitations } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export type InviteRole = "ADMIN" | "STAFF";

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
  const existingMember = await db.select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(user, eq(memberships.userId, user.id))
    .where(and(eq(memberships.workspaceId, input.workspaceId), sql`lower(${user.email}) = ${email}`))
    .limit(1);
  if (existingMember.length) throw new AppError("ALREADY_MEMBER", "That email already belongs to this workspace.", 409);

  const now = new Date();
  await db.update(workspaceInvitations)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(and(
      eq(workspaceInvitations.workspaceId, input.workspaceId),
      eq(workspaceInvitations.email, email),
      eq(workspaceInvitations.status, "PENDING"),
      lte(workspaceInvitations.expiresAt, now),
    ));

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  try {
    const [invitation] = await db.insert(workspaceInvitations).values({
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
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("INVITATION_EXISTS", "A pending invitation already exists for that email.", 409);
    }
    throw error;
  }
}

export async function revokeWorkspaceInvitation(workspaceId: string, invitationId: string) {
  const [invitation] = await db.update(workspaceInvitations)
    .set({ status: "REVOKED", updatedAt: new Date() })
    .where(and(
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.id, invitationId),
      eq(workspaceInvitations.status, "PENDING"),
    ))
    .returning({ id: workspaceInvitations.id });
  if (!invitation) throw new AppError("INVITATION_NOT_FOUND", "Pending invitation not found.", 404);
  return invitation;
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

export async function updateWorkspaceMemberRole(workspaceId: string, userId: string, role: InviteRole) {
  const [member] = await db.update(memberships).set({ role })
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .returning({ userId: memberships.userId, role: memberships.role });
  if (!member) throw new AppError("MEMBER_NOT_FOUND", "Workspace member not found.", 404);
  return member;
}

export async function removeWorkspaceMember(workspaceId: string, userId: string) {
  const [member] = await db.delete(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .returning({ userId: memberships.userId, role: memberships.role });
  if (!member) throw new AppError("MEMBER_NOT_FOUND", "Workspace member not found.", 404);
  return member;
}

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, workspaces } from "@/db/schema";

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
    .where(and(eq(memberships.userId, userId), eq(workspaces.status, "ACTIVE")))
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
      .where(and(eq(memberships.userId, user.id), eq(workspaces.status, "ACTIVE")))
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

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceStatus: workspace.status,
      role: "OWNER",
    };
  });
}

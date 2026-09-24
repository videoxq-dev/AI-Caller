import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { licenses, workspaceCommercialOwners, workspaces } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export async function requireAgencyManagedWorkspace(purchaserUserId: string, workspaceId: string) {
  const [workspace] = await db.select({
    workspaceId: workspaces.id,
    workspaceName: workspaces.name,
    workspaceStatus: workspaces.status,
    kind: workspaceCommercialOwners.kind,
    purchaserUserId: workspaceCommercialOwners.purchaserUserId,
  })
    .from(workspaceCommercialOwners)
    .innerJoin(workspaces, eq(workspaces.id, workspaceCommercialOwners.workspaceId))
    .where(and(
      eq(workspaceCommercialOwners.workspaceId, workspaceId),
      eq(workspaceCommercialOwners.purchaserUserId, purchaserUserId),
    ))
    .limit(1);

  if (!workspace) {
    throw new AppError(
      "AGENCY_WORKSPACE_NOT_MANAGED",
      "This workspace is not commercially managed by your Agency account.",
      404,
    );
  }
  if (workspace.workspaceStatus !== "ACTIVE") {
    throw new AppError("WORKSPACE_SUSPENDED", "This workspace is suspended.", 403);
  }

  const [agency] = await db.select({ id: licenses.id }).from(licenses).where(and(
    eq(licenses.purchaserUserId, purchaserUserId),
    eq(licenses.status, "ACTIVE"),
    sql`${licenses.productCode} in ('AGENCY_50', 'AGENCY_100')`,
  )).limit(1);
  if (!agency) {
    throw new AppError("AGENCY_REQUIRED", "An active Agency package is required.", 403);
  }
  return workspace;
}

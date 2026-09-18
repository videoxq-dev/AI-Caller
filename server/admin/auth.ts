import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { platformAdmins, userAdminStates } from "@/db/schema";
import { auth } from "@/server/auth";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";

function bootstrapAdmins() {
  return new Set(
    getEnv().PLATFORM_ADMIN_EMAILS
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function assertPlatformUserActive(userId: string) {
  const [state] = await db.select().from(userAdminStates)
    .where(eq(userAdminStates.userId, userId))
    .limit(1);
  if (state?.status === "SUSPENDED") {
    throw new AppError("USER_SUSPENDED", "This user account has been suspended.", 403);
  }
}

export async function requirePlatformAdmin(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new AppError("UNAUTHORIZED", "You must be signed in.", 401);
  await assertPlatformUserActive(session.user.id);

  const [admin] = await db.select().from(platformAdmins)
    .where(eq(platformAdmins.userId, session.user.id))
    .limit(1);

  const bootstrap = bootstrapAdmins().has(session.user.email.trim().toLowerCase());
  if (admin && !admin.active) {
    throw new AppError("PLATFORM_ADMIN_DISABLED", "Platform admin access is disabled for this account.", 403);
  }
  if (!admin && !bootstrap) {
    throw new AppError("PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required.", 403);
  }

  return {
    session,
    platformAdmin: {
      role: admin?.role ?? "BOOTSTRAP_ADMIN",
      source: admin ? "DATABASE" as const : "BOOTSTRAP" as const,
    },
  };
}

export async function isPlatformAdmin(userId: string, email: string) {
  const [admin] = await db.select().from(platformAdmins)
    .where(and(eq(platformAdmins.userId, userId), eq(platformAdmins.active, true)))
    .limit(1);
  return Boolean(admin) || bootstrapAdmins().has(email.trim().toLowerCase());
}

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import { authSchema } from "@/db/schema";
import { getEnv } from "@/server/env";
import { isGuardedE2EFixtureMode } from "@/server/e2e-mode";
import { enqueueJob } from "@/server/jobs";
import { AUTH_PASSWORD_RESET_EMAIL } from "@/server/jobs/queues";
import { logger } from "@/server/observability/logger";
import { ensureDefaultWorkspace } from "./workspace-repository";

const env = getEnv();

export const auth = betterAuth({
  appName: "AI Caller",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  rateLimit: { enabled: !isGuardedE2EFixtureMode() },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      try {
        await enqueueJob(AUTH_PASSWORD_RESET_EMAIL, {
          to: user.email,
          name: user.name,
          url,
        });
      } catch (error) {
        logger.error({ err: error, userId: user.id }, "Failed to queue password reset email");
        throw error;
      }
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          await ensureDefaultWorkspace({
            id: createdUser.id,
            name: createdUser.name,
            email: createdUser.email,
          });
        },
      },
    },
  },
  advanced: {
    database: {
      validateSchema: true,
    },
  },
  telemetry: {
    enabled: false,
  },
  logger: {
    level: "info",
    log: (level, message, ...args) => {
      if (level === "error") logger.error({ args }, message);
      else if (level === "warn") logger.warn({ args }, message);
      else if (level === "debug") logger.debug({ args }, message);
      else logger.info({ args }, message);
    },
  },
});

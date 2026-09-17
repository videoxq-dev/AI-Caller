import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  INTEGRATION_ENCRYPTION_KEY: z.string().min(1, "INTEGRATION_ENCRYPTION_KEY is required"),
  PG_BOSS_SCHEMA: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).default("pgboss"),
  SMTP_URL: z.string().url().optional(),
  SMTP_FROM: z.string().min(3).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export function resetEnvForTests() {
  cachedEnv = undefined;
}

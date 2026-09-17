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
  JVZOO_IPN_SECRET: z.string().min(1).optional(),
  JVZOO_CORE_PRODUCT_IDS: z.string().default(""),
  STARTER_CREDITS: z.coerce.number().int().positive().default(2500),
  HOSTED_AI_PROVIDER: z.enum(["openai", "gemini", "openrouter"]).default("openai"),
  HOSTED_AI_API_KEY: z.string().min(1).optional(),
  HOSTED_AI_MODEL: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  CALCOM_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2024-08-13"),
  META_APP_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(1).optional(),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().min(1).optional(),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v22.0"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8).optional(),
  META_PHONE_REGISTRATION_PIN: z.string().regex(/^\d{6}$/).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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

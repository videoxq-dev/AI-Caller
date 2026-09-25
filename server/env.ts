import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  INTEGRATION_ENCRYPTION_KEY: z.string().min(1, "INTEGRATION_ENCRYPTION_KEY is required"),
  PG_BOSS_SCHEMA: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).default("pgboss"),
  SMTP_URL: z.preprocess((v) => v === "" ? undefined : v, z.string().url().optional()),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURE: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(3).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JVZOO_IPN_SECRET: z.string().min(1).optional(),
  JVZOO_CORE_PRODUCT_IDS: z.string().default(""),
  JVZOO_UNLIMITED_PRODUCT_IDS: z.string().default(""),
  JVZOO_PERFORMANCE_PRODUCT_IDS: z.string().default(""),
  JVZOO_AGENCY_50_PRODUCT_IDS: z.string().default(""),
  JVZOO_AGENCY_100_PRODUCT_IDS: z.string().default(""),
  JVZOO_WHITELABEL_PRODUCT_IDS: z.string().default(""),
  STARTER_CREDITS: z.coerce.number().int().positive().default(15_000),
  PLATFORM_ADMIN_EMAILS: z.string().default(""),
  STRIPE_RESTRICTED_API_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  HOSTED_AI_PROVIDER: z.enum(["openai", "gemini", "openrouter"]).default("openai"),
  HOSTED_AI_API_KEY: z.string().min(1).optional(),
  HOSTED_AI_MODEL: z.string().min(1).optional(),
  HOSTED_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(1200),
  HOSTED_TELNYX_API_KEY: z.string().min(1).optional(),
  HOSTED_WEBHOOK_BASE_URL: z.preprocess((v) => v === "" ? undefined : v, z.string().url().optional()),
  HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY: z.string().min(1).optional(),
  HOSTED_TELEPHONY_TARGET_MARGIN_BPS: z.coerce.number().int().min(0).max(9500).default(5000),
  HOSTED_SMS_TELNYX_API_KEY: z.string().min(1).optional(),
  HOSTED_SMS_TELNYX_WEBHOOK_PUBLIC_KEY: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  CALCOM_BOOKINGS_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-02-25"),
  CALCOM_SLOTS_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2024-09-04"),
  META_APP_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(1).optional(),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().min(1).optional(),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v22.0"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8).optional(),
  META_PHONE_REGISTRATION_PIN: z.string().regex(/^\d{6}$/).optional(),
  VOICE_GATEWAY_URL: z.string().url().optional(),
  VOICE_REALTIME_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  VOICE_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  VOICE_RECORDING_STORAGE_BACKEND: z.enum(["filesystem", "s3"]).default("filesystem"),
  VOICE_RECORDING_ALLOW_PERSISTENT_FILESYSTEM: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  VOICE_RECORDING_DIR: z.string().min(1).default(".data/recordings"),
  VOICE_RECORDING_S3_BUCKET: z.string().min(1).optional(),
  VOICE_RECORDING_S3_REGION: z.string().min(1).default("us-east-1"),
  VOICE_RECORDING_S3_ENDPOINT: z.string().url().optional(),
  VOICE_RECORDING_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  VOICE_RECORDING_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  BRAND_ASSET_STORAGE_BACKEND: z.enum(["filesystem", "s3"]).default("filesystem"),
  BRAND_ASSET_ALLOW_PERSISTENT_FILESYSTEM: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  BRAND_ASSET_DIR: z.string().min(1).default(".data/brand-assets"),
  BRAND_ASSET_S3_BUCKET: z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional()),
  BRAND_ASSET_S3_REGION: z.string().min(1).default("us-east-1"),
  BRAND_ASSET_S3_ENDPOINT: z.preprocess((v) => v === "" ? undefined : v, z.string().url().optional()),
  BRAND_ASSET_S3_ACCESS_KEY_ID: z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional()),
  BRAND_ASSET_S3_SECRET_ACCESS_KEY: z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional()),
  WHITELABEL_PUBLIC_IPV4: z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional()),
  WHITELABEL_PUBLIC_IPV6: z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional()),
  WHITELABEL_CANONICAL_HOST: z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional()),
  WHITELABEL_RESERVED_HOSTS: z.string().default(""),
  WHITELABEL_DOMAIN_ROUTE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  WHITELABEL_TRAEFIK_DYNAMIC_DIR: z.string().min(1).default(".data/traefik-domains"),
  WHITELABEL_TRAEFIK_ENTRYPOINT: z.string().regex(/^[A-Za-z0-9_-]+$/).default("websecure"),
  WHITELABEL_TRAEFIK_CERT_RESOLVER: z.string().regex(/^[A-Za-z0-9_-]+$/).default("letsencrypt"),
  WHITELABEL_TRAEFIK_SERVICE_URL: z.string().url().default("http://aicaller-web:8080"),
  WHITELABEL_TLS_PROBE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
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

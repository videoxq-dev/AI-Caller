CREATE TABLE IF NOT EXISTS "platform_admins" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text DEFAULT 'ADMIN' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_admin_states" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "reason" text,
  "updated_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "admin_audit_created_idx" ON "admin_audit_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "admin_audit_target_idx" ON "admin_audit_logs" ("target_type", "target_id", "created_at");
CREATE INDEX IF NOT EXISTS "admin_audit_actor_idx" ON "admin_audit_logs" ("actor_user_id", "created_at");

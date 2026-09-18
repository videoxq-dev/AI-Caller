CREATE TYPE "workspace_invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

CREATE TABLE "workspace_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" "membership_role" NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "status" "workspace_invitation_status" NOT NULL DEFAULT 'PENDING',
  "invited_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "workspace_invitations_workspace_idx"
ON "workspace_invitations" ("workspace_id", "created_at");

CREATE INDEX "workspace_invitations_email_idx"
ON "workspace_invitations" ("email");

CREATE UNIQUE INDEX "workspace_invitations_workspace_email_pending_uq"
ON "workspace_invitations" ("workspace_id", "email")
WHERE "status" = 'PENDING';

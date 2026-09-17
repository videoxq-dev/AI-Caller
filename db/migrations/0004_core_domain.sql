CREATE TYPE "contact_channel" AS ENUM ('PHONE', 'SMS', 'WHATSAPP', 'WEBCHAT');
CREATE TYPE "lead_status" AS ENUM ('NEW', 'QUALIFIED', 'BOOKED', 'WON', 'LOST');
CREATE TYPE "conversation_status" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "handling_mode" AS ENUM ('AI', 'HUMAN');
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');
CREATE TYPE "message_sender_type" AS ENUM ('CUSTOMER', 'AI', 'USER', 'SYSTEM');
CREATE TYPE "message_content_type" AS ENUM ('TEXT', 'CALL_TRANSCRIPT', 'APPOINTMENT_EVENT', 'SYSTEM_EVENT');
CREATE TYPE "appointment_status" AS ENUM ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

CREATE TABLE "contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text,
  "email" text,
  "phone" text,
  "notes" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "contacts_workspace_updated_idx" ON "contacts" ("workspace_id", "updated_at");
CREATE INDEX "contacts_workspace_email_idx" ON "contacts" ("workspace_id", "email");
CREATE INDEX "contacts_workspace_phone_idx" ON "contacts" ("workspace_id", "phone");

CREATE TABLE "contact_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "channel" "contact_channel" NOT NULL,
  "external_id" text NOT NULL,
  "normalized_value" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "contact_identities_workspace_channel_value_uq" ON "contact_identities" ("workspace_id", "channel", "normalized_value");
CREATE INDEX "contact_identities_contact_idx" ON "contact_identities" ("contact_id");

CREATE TABLE "contact_tags" (
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "tag" text NOT NULL,
  CONSTRAINT "contact_tags_pk" PRIMARY KEY ("contact_id", "tag")
);

CREATE TABLE "leads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "status" "lead_status" DEFAULT 'NEW' NOT NULL,
  "intent" text,
  "service_requested" text,
  "source" text,
  "estimated_value" integer,
  "assigned_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "leads_workspace_contact_uq" ON "leads" ("workspace_id", "contact_id");
CREATE INDEX "leads_workspace_status_idx" ON "leads" ("workspace_id", "status");

CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "status" "conversation_status" DEFAULT 'OPEN' NOT NULL,
  "handling_mode" "handling_mode" DEFAULT 'AI' NOT NULL,
  "assigned_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "last_message_at" timestamptz,
  "ai_paused_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "conversations_workspace_activity_idx" ON "conversations" ("workspace_id", "last_message_at");
CREATE INDEX "conversations_contact_status_idx" ON "conversations" ("contact_id", "status");

CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "channel" "contact_channel" NOT NULL,
  "direction" "message_direction" NOT NULL,
  "sender_type" "message_sender_type" NOT NULL,
  "content_type" "message_content_type" DEFAULT 'TEXT' NOT NULL,
  "body" text NOT NULL,
  "provider" text,
  "external_message_id" text,
  "status" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "messages_conversation_created_idx" ON "messages" ("conversation_id", "created_at");
CREATE UNIQUE INDEX "messages_workspace_provider_external_uq" ON "messages" ("workspace_id", "provider", "external_message_id");

CREATE TABLE "appointments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
  "integration_id" uuid REFERENCES "integrations"("id") ON DELETE SET NULL,
  "external_event_id" text,
  "service_id" uuid REFERENCES "services"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "timezone" text NOT NULL,
  "status" "appointment_status" DEFAULT 'PENDING' NOT NULL,
  "booking_source" text,
  "notes" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "appointments_workspace_start_idx" ON "appointments" ("workspace_id", "starts_at");
CREATE INDEX "appointments_contact_start_idx" ON "appointments" ("contact_id", "starts_at");
CREATE UNIQUE INDEX "appointments_integration_external_uq" ON "appointments" ("integration_id", "external_event_id");

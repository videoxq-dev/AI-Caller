CREATE TABLE IF NOT EXISTS "knowledge_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "source_url" text,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "knowledge_sources_workspace_created_idx"
  ON "knowledge_sources" ("workspace_id", "created_at");

CREATE INDEX IF NOT EXISTS "knowledge_sources_workspace_kind_idx"
  ON "knowledge_sources" ("workspace_id", "kind");

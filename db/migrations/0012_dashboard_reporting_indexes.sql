CREATE INDEX IF NOT EXISTS "messages_workspace_created_idx"
  ON "messages" ("workspace_id", "created_at");

CREATE INDEX IF NOT EXISTS "leads_workspace_qualification_idx"
  ON "leads" ("workspace_id", "qualification_completed_at");

CREATE INDEX IF NOT EXISTS "appointments_workspace_created_idx"
  ON "appointments" ("workspace_id", "created_at");

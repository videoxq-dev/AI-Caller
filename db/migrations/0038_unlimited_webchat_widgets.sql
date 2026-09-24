ALTER TABLE "webchat_widgets"
  ADD COLUMN "id" uuid DEFAULT gen_random_uuid(),
  ADD COLUMN "name" text DEFAULT 'Website chat' NOT NULL,
  ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;

UPDATE "webchat_widgets" SET "is_primary" = true;

ALTER TABLE "webchat_widgets"
  ALTER COLUMN "id" SET NOT NULL,
  DROP CONSTRAINT "webchat_widgets_pkey",
  ADD CONSTRAINT "webchat_widgets_pkey" PRIMARY KEY ("id");

CREATE INDEX "webchat_widgets_workspace_created_idx"
  ON "webchat_widgets" ("workspace_id", "created_at");

CREATE UNIQUE INDEX "webchat_widgets_workspace_primary_uq"
  ON "webchat_widgets" ("workspace_id")
  WHERE "is_primary" = true;

ALTER TABLE "webchat_sessions"
  ADD COLUMN "widget_id" uuid;

UPDATE "webchat_sessions" AS session
SET "widget_id" = widget."id"
FROM "webchat_widgets" AS widget
WHERE widget."workspace_id" = session."workspace_id"
  AND widget."is_primary" = true;

ALTER TABLE "webchat_sessions"
  ALTER COLUMN "widget_id" SET NOT NULL,
  ADD CONSTRAINT "webchat_sessions_widget_id_webchat_widgets_id_fk"
    FOREIGN KEY ("widget_id") REFERENCES "webchat_widgets"("id") ON DELETE RESTRICT;

CREATE INDEX "webchat_sessions_widget_created_idx"
  ON "webchat_sessions" ("widget_id", "created_at");

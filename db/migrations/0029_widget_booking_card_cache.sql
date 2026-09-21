-- Structured booking cards survive cached SSE replies, history, and refresh.
ALTER TABLE "webchat_turns"
  ADD COLUMN "response_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;

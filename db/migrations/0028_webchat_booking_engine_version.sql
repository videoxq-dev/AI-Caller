-- Existing sessions remain v1 until they expire or explicitly start a new session.
ALTER TABLE "webchat_sessions"
  ADD COLUMN "booking_engine_version" text NOT NULL DEFAULT 'v1'
    CHECK ("booking_engine_version" IN ('v1','v2'));

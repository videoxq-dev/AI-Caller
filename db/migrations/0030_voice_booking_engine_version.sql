-- Pin an inbound call to its booking engine when that call starts. Existing calls
-- stay on v1; a mid-call workspace rollout must not replace its mutable state.
ALTER TABLE "voice_calls" ADD COLUMN "booking_engine_version" text NOT NULL DEFAULT 'v1'
  CHECK ("booking_engine_version" IN ('v1','v2'));

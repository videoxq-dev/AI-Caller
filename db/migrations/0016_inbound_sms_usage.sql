CREATE UNIQUE INDEX IF NOT EXISTS "usage_events_sms_inbound_reference_uq"
  ON "usage_events" ("workspace_id", "reference_type", "reference_id")
  WHERE "reference_type" = 'SMS_INBOUND' AND "reference_id" IS NOT NULL;

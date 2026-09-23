-- An appointment can return to an earlier start time. A monotonic revision keeps
-- previously queued reminders invalid even when their expected time matches again.
ALTER TABLE "appointments" ADD COLUMN "revision" integer NOT NULL DEFAULT 0;

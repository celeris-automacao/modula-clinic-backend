ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "last_reminder_at" timestamp with time zone;

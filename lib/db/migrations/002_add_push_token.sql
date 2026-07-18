-- Migration 002: add push_token to patients table
-- Stores the Expo push token collected from the patient mobile app.
-- Used by the notify endpoint to send server-triggered push reminders.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS push_token text;

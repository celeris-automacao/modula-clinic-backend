-- Migration 003: add last_reminder_at to patients table
-- Tracks when the last push reminder was sent to a patient.
-- Used by the notify endpoint to prevent sending more than one reminder per day.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;

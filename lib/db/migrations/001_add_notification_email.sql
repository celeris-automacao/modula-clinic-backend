-- Migration 001: add notification_email to users table
-- Allows professionals to configure a dedicated alert e-mail address
-- separate from their Replit Auth login e-mail.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email varchar;

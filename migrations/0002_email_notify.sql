-- Per-person opt-out for notification emails (EMAIL_NOTIFY); on by default.
ALTER TABLE users ADD COLUMN email_notify INTEGER NOT NULL DEFAULT 1;

-- Console sign-up marks the email as verified by default (no SMTP needed).
-- A platform admin can turn this off once a mailer is configured.
ALTER TABLE platform_auth_global_settings
  ADD COLUMN IF NOT EXISTS console_signup_auto_verify_email BOOLEAN NOT NULL DEFAULT TRUE;

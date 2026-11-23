-- 0013_vellum_rebrand.sql — Control plane
--
-- Moves stored control-plane configuration off the docdb.dev domain. Schema
-- defaults for new rows already say vellum.dev; this statement rewrites the
-- value in databases that stored the old default. Only exact matches of the
-- old default are touched — any operator-customized sender is preserved.

UPDATE platform_auth_global_settings
   SET platform_smtp_from_email = 'noreply@vellum.dev'
 WHERE platform_smtp_from_email = 'noreply@docdb.dev';

-- QA/visual seed identity renamed to the new domain so the QA scripts (which
-- now sign in as visual-admin@vellum.dev) keep working. No-op where the seed
-- user does not exist.
UPDATE users
   SET email = 'visual-admin@vellum.dev'
 WHERE LOWER(email) = 'visual-admin@docdb.dev'
   AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(email) = 'visual-admin@vellum.dev');

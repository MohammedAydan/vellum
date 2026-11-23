-- Data Plane: refresh-token rotation grace window.
--
-- `rotated_at` records when a session's refresh token was last rotated. The
-- refresh endpoint accepts the immediately-previous refresh token for a short
-- (15s) window after rotation so concurrent browser tabs all succeed, and treats
-- any later replay as theft (revoking all sessions for that user).

ALTER TABLE project_auth_sessions ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

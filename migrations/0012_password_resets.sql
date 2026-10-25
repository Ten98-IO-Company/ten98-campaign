-- Self-service password recovery (ten98-campaign#284). Each row is one outstanding reset link: only a keyed hash of the
-- emailed token is stored, a user has at most one row, and a reset or a newer request removes it.
CREATE TABLE password_resets (token_hash text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL, created_at bigint NOT NULL);

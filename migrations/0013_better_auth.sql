-- Identity moves onto Better Auth through @ten98/runtime/auth (ten98-code-system#97). users keeps its name, ids and
-- references, and gains Better Auth's user fields. Each local password moves unchanged into a 'credential' account, so it
-- still verifies through the preset's legacy scrypt check and is rehashed on the next successful sign-in. Every existing
-- session and reset link ends here, which issue #97 accepts as a one-time re-sign-in. Times stay bigint epoch milliseconds.
-- Emails are unique ignoring case, as the preset's schema requires; an installation whose accounts already collide stops
-- here, before anything changes, so they can be merged first.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) THEN RAISE EXCEPTION 'Two or more accounts use the same email address in different letter case. Merge them before upgrading.'; END IF; END $$;
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN image text;
ALTER TABLE users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN created_at bigint NOT NULL DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
ALTER TABLE users ADD COLUMN updated_at bigint NOT NULL DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
CREATE TABLE accounts (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, access_token text, refresh_token text, id_token text, access_token_expires_at bigint, refresh_token_expires_at bigint, scope text, password text, created_at bigint NOT NULL, updated_at bigint NOT NULL, CONSTRAINT accounts_provider_id_account_id_key UNIQUE (provider_id, account_id));
CREATE INDEX accounts_user_id_idx ON accounts (user_id);
INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid()::text, id, 'credential', id, password, created_at, created_at FROM users WHERE password IS NOT NULL;
ALTER TABLE users DROP COLUMN password;
DROP TABLE sessions;
CREATE TABLE sessions (id text PRIMARY KEY, token text NOT NULL CONSTRAINT sessions_token_key UNIQUE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL, ip_address text, user_agent text, created_at bigint NOT NULL, updated_at bigint NOT NULL);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
DROP TABLE password_resets;
CREATE TABLE verifications (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at bigint NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);
CREATE TABLE two_factors (id text PRIMARY KEY, user_id text NOT NULL CONSTRAINT two_factors_user_id_key UNIQUE REFERENCES users(id) ON DELETE CASCADE, secret text NOT NULL, backup_codes text NOT NULL, verified boolean NOT NULL DEFAULT true, failed_verification_count integer NOT NULL DEFAULT 0, locked_until bigint);

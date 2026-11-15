-- Development only: undoes migrations/0014_better_auth.sql. The migration ledger never runs this file (it is not in
-- server/database.ts's list); tests/identity-better-auth.test.ts applies 0014, runs this, and applies 0014 again.
-- users comes back with its ids and every foreign key. Each credential hash returns to users.password; one that Better Auth
-- has already rehashed stays in Better Auth's format, which the pre-move code cannot verify. Emails stay lower-case, and
-- sessions, reset links and second factors are not restored (0014 ended them).
DROP TABLE "twoFactor";
DROP TABLE verification;
DROP TABLE session;
ALTER TABLE "user" ADD COLUMN password text;
UPDATE "user" SET password = account.password FROM account WHERE account."userId" = "user".id AND account."providerId" = 'credential';
DROP TABLE account;
ALTER TABLE "user" DROP COLUMN "emailVerified", DROP COLUMN image, DROP COLUMN "createdAt", DROP COLUMN "updatedAt", DROP COLUMN "twoFactorEnabled", DROP COLUMN closed_at;
DROP INDEX user_email_normalized_idx;
ALTER TABLE "user" DROP CONSTRAINT user_email_lowercase;
ALTER TABLE "user" RENAME CONSTRAINT user_email_key TO users_email_key;
ALTER INDEX user_pkey RENAME TO users_pkey;
ALTER TABLE "user" RENAME TO users;
CREATE TABLE sessions (token text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL);
CREATE TABLE password_resets (token_hash text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL, created_at bigint NOT NULL);
DELETE FROM schema_version WHERE version = '0014';

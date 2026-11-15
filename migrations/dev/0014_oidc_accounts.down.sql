-- Development only: undoes migrations/0014_oidc_accounts.sql (run before 0013_better_auth.down.sql). The migration ledger
-- never runs this file; tests/identity-better-auth.test.ts applies 0013 and 0014, reverses both and applies them again.
CREATE TABLE oidc_identities (issuer text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, PRIMARY KEY (issuer, subject));
INSERT INTO oidc_identities SELECT substr("providerId", 6), "accountId", "userId" FROM account WHERE "providerId" LIKE 'oidc:%';
DELETE FROM account WHERE "providerId" LIKE 'oidc:%';
DELETE FROM schema_version WHERE version = '0014';

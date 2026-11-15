-- Development only: undoes migrations/0015_oidc_accounts.sql (run before 0014_better_auth.down.sql). The migration ledger
-- never runs this file; tests/identity-better-auth.test.ts applies 0014 and 0015, reverses both and applies them again.
-- Issuers come back in the form the preset normalised them to.
CREATE TABLE oidc_identities (issuer text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, PRIMARY KEY (issuer, subject));
INSERT INTO oidc_identities SELECT substr("providerId", 6), "accountId", "userId" FROM account WHERE "providerId" LIKE 'oidc:%';
DELETE FROM account WHERE "providerId" LIKE 'oidc:%';
DELETE FROM schema_version WHERE version = '0015';

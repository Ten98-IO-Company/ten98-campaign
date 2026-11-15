-- Identity moves onto Better Auth through @ten98/runtime/auth (ten98-code-system#97), in the common schema the preset reads
-- (code-system workspace-team.sql) and Better Auth's default model names: "user", account, session, verification and
-- "twoFactor", with camelCase columns and timestamptz. users is renamed, so its ids and every foreign key that points at it
-- are kept. Each local password moves unchanged into a 'credential' account, where the preset's legacy scrypt check accepts
-- it and rehashes it once. Every existing session and pending reset link ends here (a one-time re-sign-in, #97). The
-- migration ledger applies this file in one transaction, so the pre-check's refusal also undoes the rename before it.
ALTER TABLE users RENAME TO "user";
ALTER INDEX users_pkey RENAME TO user_pkey;
ALTER TABLE "user" RENAME CONSTRAINT users_email_key TO user_email_key;
ALTER TABLE "user" ADD COLUMN "emailVerified" boolean NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN image text;
ALTER TABLE "user" ADD COLUMN "createdAt" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "user" ADD COLUMN "updatedAt" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN closed_at timestamptz;
-- An OIDC account's email was verified by its provider: Campaign provisioned one only for email_verified = true. Password
-- accounts never proved their address, so they stay false; nothing in Campaign or the preset reads the flag today.
UPDATE "user" SET "emailVerified" = true WHERE id IN (SELECT user_id FROM oidc_identities);
CREATE TABLE account (id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, "userId" text NOT NULL CONSTRAINT "account_userId_fkey" REFERENCES "user"(id) ON DELETE CASCADE, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "account_providerId_accountId_key" UNIQUE ("providerId", "accountId"));
CREATE INDEX account_user_idx ON account ("userId");
INSERT INTO account (id, "accountId", "providerId", "userId", password) SELECT gen_random_uuid()::text, id, 'credential', id, password FROM "user" WHERE password IS NOT NULL;
ALTER TABLE "user" DROP COLUMN password;
DROP TABLE sessions;
CREATE TABLE session (id text PRIMARY KEY, token text NOT NULL CONSTRAINT session_token_key UNIQUE, "userId" text NOT NULL CONSTRAINT "session_userId_fkey" REFERENCES "user"(id) ON DELETE CASCADE, "expiresAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX session_user_idx ON session ("userId");
DROP TABLE password_resets;
CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX verification_identifier_idx ON verification (identifier);
CREATE TABLE "twoFactor" (id text PRIMARY KEY, "userId" text NOT NULL CONSTRAINT "twoFactor_userId_key" UNIQUE CONSTRAINT "twoFactor_userId_fkey" REFERENCES "user"(id) ON DELETE CASCADE, secret text NOT NULL, "backupCodes" text NOT NULL, verified boolean NOT NULL DEFAULT true, "failedVerificationCount" integer NOT NULL DEFAULT 0, "lockedUntil" timestamptz);
-- The preset's token-storage upgrade, verbatim (tokenStorageUpgradeStatements, @ten98/runtime/auth; the identity test holds
-- this file to the export): it ends sessions and pending links (none are left here), adds session."oidcProvider", and
-- stores emails lower-case after the #143 pre-check, which stops the migration while two accounts share an email ignoring
-- case.
DELETE FROM "session";
--> statement-breakpoint
DELETE FROM verification WHERE identifier LIKE 'reset-password:%' OR identifier LIKE 'trust-device-%' OR identifier LIKE '2fa-%';
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "oidcProvider" text;
--> statement-breakpoint
DO $$
DECLARE twins integer; listed text;
BEGIN
  SELECT count(*), string_agg(ids, ', ' ORDER BY first) FILTER (WHERE n <= 20)
    INTO twins, listed
    FROM (SELECT '[' || string_agg(id, ', ' ORDER BY id) || ']' AS ids, min(id) AS first, row_number() OVER (ORDER BY min(id)) AS n
          FROM "user" GROUP BY lower(email) HAVING count(*) > 1) shared;
  IF twins > 0 THEN
    RAISE EXCEPTION 'user_email_lowercase: % email address(es) belong to more than one user when case is ignored (accounts: %); resolve them before this migration',
      twins, listed || CASE WHEN twins > 20 THEN ', …' ELSE '' END;
  END IF;
END
$$;
--> statement-breakpoint
UPDATE "user" SET email = lower(email) WHERE email <> lower(email);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_email_lowercase' AND conrelid = '"user"'::regclass) THEN
    ALTER TABLE "user" ADD CONSTRAINT user_email_lowercase CHECK (email = lower(email)) NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "user" VALIDATE CONSTRAINT user_email_lowercase;
-- The locked lookups find one account per email through this index (assertEmailIndex).
CREATE UNIQUE INDEX user_email_normalized_idx ON "user" (lower(email));

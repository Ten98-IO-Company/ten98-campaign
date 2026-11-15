-- OIDC identities become Better Auth account rows (ten98-code-system#97, #143): provider 'oidc:<issuer>', account id the
-- subject, the same user. account's unique ("providerId", "accountId") keeps one link per issuer and subject, as the old
-- primary key did. No access, refresh or ID token is stored.
INSERT INTO account (id, "accountId", "providerId", "userId") SELECT gen_random_uuid()::text, subject, 'oidc:' || issuer, user_id FROM oidc_identities;
DROP TABLE oidc_identities;

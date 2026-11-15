-- OIDC identities become Better Auth account rows (ten98-code-system#97, #143): provider 'oidc:' plus the issuer as the
-- preset normalises it (oidcProviderId), account id the subject, the same user. account's unique ("providerId",
-- "accountId") keeps one link per issuer and subject, as the old primary key did. No access, refresh or ID token is stored.
-- The preset's normaliser as SQL, verbatim (normaliseOidcIssuerSql, @ten98/runtime/auth; the identity test holds this file
-- to the export). It is session-scoped and dropped again below.
CREATE OR REPLACE FUNCTION pg_temp.ten98_normalise_oidc_issuer(issuer text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $normalise$
  SELECT CASE WHEN m IS NULL OR m[3] !~ '^(\[[^]]*\]|[^]:[]+)(:[0-9]*)?$' OR right(m[4], 2) = '//' THEN NULL ELSE s || '://' || m[2]
    || CASE WHEN s = 'https' AND right(h, 4) = ':443' THEN left(h, -4) WHEN s = 'http' AND right(h, 3) = ':80' THEN left(h, -3) ELSE h END
    || CASE WHEN right(m[4], 1) = '/' THEN left(m[4], -1) ELSE m[4] END || m[5] END
  FROM regexp_match(issuer, '^([A-Za-z][A-Za-z0-9+.-]*)://((?:[^/?#]*@)?)([^/?#]*)([^?#]*)(.*)$') AS m,
    LATERAL (SELECT translate(m[1], 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS s,
                    regexp_replace(translate(m[3], 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), ':$', '') AS h) AS v
$normalise$;
-- Stop, and change nothing, when an issuer cannot be normalised or two identities would become one link.
DO $$
DECLARE malformed integer; merged integer;
BEGIN
  SELECT count(*) INTO malformed FROM oidc_identities WHERE pg_temp.ten98_normalise_oidc_issuer(issuer) IS NULL;
  SELECT count(*) INTO merged FROM (SELECT 1 FROM oidc_identities GROUP BY pg_temp.ten98_normalise_oidc_issuer(issuer), subject HAVING count(*) > 1) shared;
  IF malformed > 0 OR merged > 0 THEN
    RAISE EXCEPTION 'oidc_accounts: % identit(y/ies) with an issuer that is not a URL and % issuer and subject pair(s) that differ only in issuer form; resolve them before this migration', malformed, merged;
  END IF;
END
$$;
INSERT INTO account (id, "accountId", "providerId", "userId") SELECT gen_random_uuid()::text, subject, 'oidc:' || pg_temp.ten98_normalise_oidc_issuer(issuer), user_id FROM oidc_identities;
DROP TABLE oidc_identities;
DROP FUNCTION pg_temp.ten98_normalise_oidc_issuer(text);

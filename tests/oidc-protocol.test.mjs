// The real openid-client against a local issuer shaped like Authentik in its default per-application issuer mode:
// issuer, discovery and JWKS under /application/o/<slug>/ (issuer with its trailing slash), global authorize and
// token endpoints, RS256 ID tokens and client_secret_post/basic. Synthetic keys and accounts only; fixture success
// is not certification of a live provider. auth-races.test.mjs stubs the client boundary; this file does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createAuth } from '../server/auth.ts';
import { postgresSkip, signInRedirectError, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip };
const appUrl = 'https://campaign.example', clientId = 'campaign-fixture-client', clientSecret = randomBytes(24).toString('base64url');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const challengeOf = verifier => createHash('sha256').update(verifier).digest('base64url');
function response() {
  return { headers: {}, status: null, ended: false, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() { this.ended = true; } };
}

async function authentikIssuer(t) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }), kid = randomBytes(8).toString('hex');
  const codes = new Map(), issued = { tokenRequests: 0 };
  const server = createServer((req, res) => {
    const path = new URL(req.url, issuer).pathname, reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (path === '/application/o/campaign/.well-known/openid-configuration') return reply(200, {
      issuer, authorization_endpoint: origin + '/application/o/authorize/', token_endpoint: origin + '/application/o/token/', userinfo_endpoint: origin + '/application/o/userinfo/',
      end_session_endpoint: issuer + 'end-session/', jwks_uri: issuer + 'jwks/', response_types_supported: ['code', 'id_token', 'id_token token', 'code token', 'code id_token', 'code id_token token'],
      grant_types_supported: ['authorization_code', 'refresh_token'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'], code_challenge_methods_supported: ['plain', 'S256'],
    });
    if (path === '/application/o/campaign/jwks/') return reply(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    if (path !== '/application/o/token/' || req.method !== 'POST') return reply(404, { error: 'not_found' });
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      issued.tokenRequests++;
      const form = new URLSearchParams(body), basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
      const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent) : [form.get('client_id'), form.get('client_secret')];
      if (id !== clientId || secret !== clientSecret) return reply(401, { error: 'invalid_client' });
      const grant = codes.get(form.get('code')); codes.delete(form.get('code'));
      if (form.get('grant_type') !== 'authorization_code' || !grant || form.get('redirect_uri') !== grant.redirectUri || challengeOf(form.get('code_verifier') || '') !== grant.challenge) return reply(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000), header = { alg: 'RS256', kid, typ: 'JWT' };
      const claims = { iss: issuer, aud: clientId, sub: grant.subject, iat: now, exp: now + 300, auth_time: now, nonce: grant.nonce, email: grant.email, email_verified: true, name: 'Fixture Member', preferred_username: 'fixture', groups: [], ...grant.claims };
      const signingInput = `${encode(header)}.${encode(claims)}`;
      reply(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, scope: 'openid email profile', id_token: `${signingInput}.${sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url')}` });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, issuer = origin + '/application/o/campaign/';
  // Stands in for Authentik's consent step: the browser returns with a code bound to the authorization request.
  const authorize = (location, { subject = 'a1b2c3d4e5f6', email = 'allowed@example.test', claims = {} } = {}) => {
    const code = randomBytes(16).toString('hex'), params = location.searchParams;
    codes.set(code, { redirectUri: params.get('redirect_uri'), challenge: params.get('code_challenge'), nonce: params.get('nonce'), subject, email, claims });
    return code;
  };
  return { issuer, authorize, issued };
}

async function signIn(t) {
  const { db } = await testDatabase(t), idp = await authentikIssuer(t);
  await db.$client.query("INSERT INTO users VALUES ('first-owner', 'Owner', 'owner@example.test', NULL)");
  const { discovery, ...real } = await import('openid-client');
  // The fixture issuer is plain HTTP on loopback; every other openid-client step runs unmodified.
  const client = { ...real, discovery: (url, id, secret) => discovery(url, id, secret, undefined, { execute: [real.allowInsecureRequests] }) };
  const auth = createAuth(db, { appUrl, sessionSecret: 'oidc-protocol-fixture-secret-of-32-characters', oidcEnabled: true, oidcIssuer: idp.issuer, oidcClientId: clientId, oidcClientSecret: clientSecret, oidcAllowedEmails: ['allowed@example.test'] }, { openidClient: async () => client });
  const start = async () => {
    const res = response();
    await auth.oidcStart({ url: '/api/auth/oidc/start', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    assert.equal(res.status, 302);
    const browser = [].concat(res.headers['Set-Cookie']).find(value => value.startsWith('ten98_oidc_') && !value.startsWith('ten98_oidc_invite_'));
    return { location: new URL(res.headers.Location), cookie: browser.split(';')[0] };
  };
  const callback = async (flow, code) => {
    const res = response();
    await auth.oidcCallback({ headers: { cookie: flow.cookie } }, res, new URL(`${appUrl}/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(flow.location.searchParams.get('state'))}`));
    return signInRedirectError(res);
  };
  return { db, idp, start, callback };
}

test('OIDC sign-in completes against an Authentik-shaped issuer with the real client', pg, async t => {
  const { db, idp, start, callback } = await signIn(t), flow = await start(), params = flow.location.searchParams;
  assert.equal(flow.location.origin + flow.location.pathname, new URL(idp.issuer).origin + '/application/o/authorize/');
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('client_id'), clientId);
  assert.equal(params.get('redirect_uri'), 'https://campaign.example/api/auth/oidc/callback');
  assert.equal(params.get('scope'), 'openid email profile');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.match(params.get('code_challenge'), /^[\w-]{43}$/);
  assert.ok(params.get('state') && params.get('nonce') && params.get('state') !== params.get('nonce'));

  const signedIn = await callback(flow, idp.authorize(flow.location));
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.headers.Location, appUrl + '/');
  assert.ok([].concat(signedIn.headers['Set-Cookie']).some(value => /^ten98_session_[0-9a-f]{16}=[\w-]{43}; /.test(value)));
  const identity = (await db.$client.query('SELECT i.issuer, i.subject, u.email FROM oidc_identities i JOIN users u ON u.id = i.user_id')).rows;
  assert.deepEqual(identity, [{ issuer: idp.issuer, subject: 'a1b2c3d4e5f6', email: 'allowed@example.test' }]);

  // A later sign-in by the same issuer and subject reuses the account even when the email claim changes.
  const again = await start(), returned = await callback(again, idp.authorize(again.location, { email: 'renamed@example.test' }));
  assert.equal(returned.status, 302);
  assert.equal((await db.$client.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 2);
  assert.equal(idp.issued.tokenRequests, 2);
});

test('OIDC callback refuses ID tokens with the wrong nonce, audience or issuer', pg, async t => {
  const { db, idp, start, callback } = await signIn(t);
  for (const claims of [{ nonce: 'another-transaction' }, { aud: 'another-client' }, { iss: 'https://auth.example/application/o/other/' }]) {
    const flow = await start();
    await assert.rejects(callback(flow, idp.authorize(flow.location, { claims })), error => error.code === 'OIDC_SIGN_IN_FAILED', JSON.stringify(claims));
  }
  assert.equal((await db.$client.query('SELECT count(*)::int AS count FROM oidc_identities')).rows[0].count, 0);
});

test('OIDC provisioning needs email_verified true, which Authentik sends only when configured', pg, async t => {
  const { db, idp, start, callback } = await signIn(t), flow = await start();
  await assert.rejects(callback(flow, idp.authorize(flow.location, { claims: { email_verified: false } })), error => error.code === 'OIDC_EMAIL_UNVERIFIED');
  assert.equal((await db.$client.query('SELECT count(*)::int AS count FROM oidc_identities')).rows[0].count, 0);
});

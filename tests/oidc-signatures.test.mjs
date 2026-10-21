import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as openid from 'openid-client';
import { createAuth } from '../server/auth.ts';
import { postgresSkip, signInRedirectError, testDatabase } from './postgres.mjs';

function response() {
  return { headers: {}, status: null, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} };
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(privateKey, claims) {
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'issuer-key' })}.${encode(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

// A local issuer publishing one RS256 key; the token endpoint signs with whichever key the test selects.
async function mockIssuer(t) {
  const published = generateKeyPairSync('rsa', { modulusLength: 2048 }), unpublished = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = { signingKey: published.privateKey, nonce: '', published, unpublished };
  const server = createServer((req, res) => {
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/.well-known/openid-configuration') return json({ issuer: issuer.url, authorization_endpoint: issuer.url + '/authorize', token_endpoint: issuer.url + '/token', jwks_uri: issuer.url + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
    if (req.url === '/jwks') return json({ keys: [{ ...published.publicKey.export({ format: 'jwk' }), kid: 'issuer-key', alg: 'RS256', use: 'sig' }] });
    if (req.url === '/token' && req.method === 'POST') {
      req.resume(); const now = Math.floor(Date.now() / 1000);
      return req.on('end', () => json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken(issuer.signingKey, { iss: issuer.url, sub: 'signed-subject', aud: 'fixture-client', iat: now, exp: now + 300, nonce: issuer.nonce, email: 'allowed@example.test', email_verified: true }) }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  issuer.url = `http://127.0.0.1:${server.address().port}`;
  return issuer;
}

test('ID token signatures are verified against the issuer JWKS', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), issuer = await mockIssuer(t);
  await db.$client.query("INSERT INTO users VALUES ('existing', 'Existing', 'existing@example.test', NULL)");
  const config = { appUrl: 'https://campaign.example', sessionSecret: 'oidc-signature-fixture-secret-32-characters', oidcEnabled: true, oidcIssuer: issuer.url, oidcClientId: 'fixture-client', oidcClientSecret: 'fixture-client-secret', oidcAllowedEmails: ['allowed@example.test'] };
  // The real openid-client; the only change lets it reach this plain-HTTP local issuer.
  const openidClient = async () => ({ ...openid, discovery: (server, clientId, metadata, auth, options = {}) => openid.discovery(server, clientId, metadata, auth, { ...options, execute: [...(options.execute || []), openid.allowInsecureRequests] }) });
  const auth = createAuth(db, config, { openidClient });
  async function signIn() {
    const started = response(); await auth.oidcStart({ url: '/api/auth/oidc/start', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, started);
    const authorize = new URL(started.headers.Location), cookie = [].concat(started.headers['Set-Cookie']).find(value => value.startsWith('ten98_oidc_')).split(';')[0];
    issuer.nonce = authorize.searchParams.get('nonce');
    const res = response(); await auth.oidcCallback({ headers: { cookie } }, res, new URL(`${config.appUrl}/api/auth/oidc/callback?state=${encodeURIComponent(authorize.searchParams.get('state'))}&code=fixture-code`)); return signInRedirectError(res);
  }
  const count = async table => (await db.$client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count;
  issuer.signingKey = issuer.unpublished.privateKey;
  await assert.rejects(signIn(), error => error.code === 'OIDC_SIGN_IN_FAILED');
  assert.equal(await count('sessions'), 0); assert.equal(await count('oidc_identities'), 0);
  issuer.signingKey = issuer.published.privateKey;
  assert.equal((await signIn()).status, 302);
  assert.equal(await count('sessions'), 1); assert.equal(await count('oidc_identities'), 1);
});

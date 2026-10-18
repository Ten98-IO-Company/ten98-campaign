import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createAuth, hashPassword, cookies, publicUser, HttpError } from '../server/auth.mjs';
import { transaction } from '../server/database.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT UNIQUE,password TEXT);
    CREATE TABLE instance_operators(user_id TEXT);
    CREATE TABLE sessions(token TEXT,user_id TEXT,expires_at INTEGER);
    CREATE TABLE login_limits(key TEXT PRIMARY KEY,count INTEGER,expires_at INTEGER);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE memberships(workspace_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE projects(id TEXT PRIMARY KEY,workspace_id TEXT,name TEXT);
    CREATE TABLE oidc_flows(state TEXT PRIMARY KEY,browser TEXT,verifier TEXT,nonce TEXT,expires_at INTEGER);
    CREATE TABLE oidc_return_targets(state TEXT PRIMARY KEY REFERENCES oidc_flows(state) ON DELETE CASCADE,invite_token TEXT NOT NULL);
    CREATE TABLE oidc_identities(issuer TEXT,subject TEXT,user_id TEXT,PRIMARY KEY(issuer,subject));`);
  return db;
}
function response() {
  return { headers: {}, status: null, ended: false, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() { this.ended = true; } };
}

test('an old-password login already verifying cannot create a session after a password change', async () => {
  const db = database(), oldPassword = 'old fixture password 2026', nextPassword = 'new fixture password 2026';
  const oldHash = await hashPassword(oldPassword), nextHash = await hashPassword(nextPassword);
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('user-a', 'Fixture', 'fixture@example.test', oldHash);
  const config = { sessionSecret: 'auth-race-fixture-session-secret-32-characters', appUrl: 'https://campaign.example' }, auth = createAuth(db, config);
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res = response();
  try {
    const pending = auth.login(req, res, { email: 'fixture@example.test', password: oldPassword });
    // login has read the old hash and yielded to asynchronous scrypt verification.
    db.prepare('UPDATE users SET password=? WHERE id=?').run(nextHash, 'user-a');
    await assert.rejects(pending, error => error.status === 401 && /password changed/i.test(error.message));
    assert.equal(res.headers['Set-Cookie'], undefined); assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
    await assert.rejects(auth.login(req, response(), { email: 'fixture@example.test', password: oldPassword }), error => error.status === 401);
    const current = response(), user = await auth.login(req, current, { email: 'fixture@example.test', password: nextPassword });
    assert.equal(user.id, 'user-a'); assert.match(current.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Max-Age=604800; Secure/); assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get().count, 1);
  } finally { db.close(); }
});

test('OIDC invitation continuation is browser-bound, single-use and origin-fixed without bypassing provisioning or identity linking', async () => {
  const db = database(), source = await readFile(new URL('../server/auth.mjs', import.meta.url), 'utf8');
  const appUrl = 'https://campaign.example', issuer = 'https://identity.example', invite = 'A'.repeat(43);
  const config = { appUrl, sessionSecret: 'oidc-continuation-fixture-secret-32-characters', oidcEnabled: true, oidcIssuer: issuer, oidcClientId: 'fixture-client', oidcAllowedEmails: ['allowed@example.test', 'local@example.test'] };
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('local-user', 'Local', 'local@example.test', 'unchanged-local-hash');
  db.prepare('INSERT INTO users VALUES(?,?,?,NULL)').run('identity-user', 'Identity', 'identity@example.test');
  db.prepare('INSERT INTO oidc_identities VALUES(?,?,?)').run(issuer, 'existing-subject', 'identity-user');
  let sequence = 0, exchanges = 0, claims = { iss: issuer, sub: 'existing-subject', email: 'identity@example.test', email_verified: true };
  // Execute the actual application flow with only the official client boundary stubbed: no IdP or network is involved.
  const oidcClient = {
    async discovery(url, clientId) { assert.equal(url.href, issuer + '/'); assert.equal(clientId, 'fixture-client'); return { fixture: true }; },
    randomState() { return 'state-' + ++sequence; }, randomNonce() { return 'nonce-' + sequence; }, randomPKCECodeVerifier() { return 'verifier-' + sequence; },
    async calculatePKCECodeChallenge(verifier) { return 'challenge-' + verifier; },
    buildAuthorizationUrl(provider, params) { assert.equal(provider.fixture, true); assert.equal(params.redirect_uri, appUrl + '/api/auth/oidc/callback'); const url = new URL(issuer + '/authorize'); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value); return url; },
    async authorizationCodeGrant(provider, url, checks) { exchanges++; assert.equal(provider.fixture, true); assert.equal(checks.expectedState, url.searchParams.get('state')); assert.match(checks.pkceCodeVerifier, /^verifier-/); assert.match(checks.expectedNonce, /^nonce-/); assert.equal(checks.idTokenExpected, true); return { claims: () => claims }; },
  };
  const factorySource = source.slice(source.indexOf('export function createAuth')).replace('export function createAuth', 'function createAuth').replace("await import('openid-client')", 'await Promise.resolve(oidcClient)');
  const factory = runInNewContext(`(() => { ${factorySource}; return createAuth; })()`, { createHmac, randomBytes, randomUUID, cookies, publicUser, HttpError, hashPassword, transaction, URL, oidcClient, maxAge: 7 * 86400 });
  const auth = factory(db, config), digest = value => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  async function start(query = '') {
    const res = response(); await auth.oidcStart({ url: '/api/auth/oidc/start' + query, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    assert.equal(res.status, 302); const authorize = new URL(res.headers.Location), cookie = res.headers['Set-Cookie'].split(';')[0];
    return { state: authorize.searchParams.get('state'), cookie, authorize };
  }
  async function callback(flow, query = '') {
    const res = response(), url = new URL(appUrl + '/api/auth/oidc/callback?state=' + encodeURIComponent(flow.state) + '&code=fixture-code' + query);
    await auth.oidcCallback({ headers: { cookie: flow.cookie } }, res, url); return res;
  }
  try {
    for (const value of ['https://attacker.example/redirect', '../escape', 'short']) await assert.rejects(start('?invite=' + encodeURIComponent(value)), error => error.status === 400);
    assert.equal(db.prepare('SELECT count(*) AS count FROM oidc_flows').get().count, 0);
    const flow = await start('?invite=' + invite + '&returnTo=https%3A%2F%2Fattacker.example');
    const row = db.prepare('SELECT * FROM oidc_return_targets').get(); assert.equal(row.state, digest(flow.state)); assert.equal(row.invite_token, invite);
    await assert.rejects(callback({ ...flow, cookie: 'ten98_oidc=wrong-browser' }), error => error.status === 400); assert.equal(exchanges, 0); assert.equal(db.prepare('SELECT count(*) AS count FROM oidc_return_targets').get().count, 1);
    const accepted = await callback(flow, '&invite=' + 'B'.repeat(43) + '&returnTo=https%3A%2F%2Fattacker.example');
    assert.equal(accepted.status, 302); assert.equal(accepted.headers.Location, appUrl + '/?invite=' + invite); assert.equal(accepted.ended, true); assert.equal(exchanges, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM oidc_flows').get().count, 0); assert.equal(db.prepare('SELECT count(*) AS count FROM oidc_return_targets').get().count, 0);
    await assert.rejects(callback(flow), error => error.status === 400); assert.equal(exchanges, 1);
    const noInvite = await start('?returnTo=https%3A%2F%2Fattacker.example');
    assert.equal((await callback(noInvite, '&invite=' + invite)).headers.Location, appUrl + '/');
    const expired = await start('?invite=' + invite); db.prepare('UPDATE oidc_flows SET expires_at=0 WHERE state=?').run(digest(expired.state));
    const beforeExpiry = exchanges; await assert.rejects(callback(expired), error => error.status === 400); assert.equal(exchanges, beforeExpiry);
    const denied = await start('?invite=' + invite); claims = { iss: issuer, sub: 'new-unprovisioned-subject', email: 'outside@example.test', email_verified: true };
    await assert.rejects(callback(denied), error => error.status === 403); assert.equal(db.prepare('SELECT * FROM users WHERE email=?').get('outside@example.test'), undefined);
    assert.equal(db.prepare('SELECT * FROM oidc_return_targets WHERE state=?').get(digest(denied.state)), undefined);
    const linking = await start('?invite=' + invite); claims = { iss: issuer, sub: 'unlinked-subject', email: 'local@example.test', email_verified: true };
    await assert.rejects(callback(linking), error => error.status === 403 && /linking is disabled/.test(error.message));
    assert.equal(db.prepare('SELECT password FROM users WHERE id=?').get('local-user').password, 'unchanged-local-hash');
    assert.equal(db.prepare('SELECT * FROM oidc_identities WHERE subject=?').get('unlinked-subject'), undefined);
  } finally { db.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuth, hashPassword, signInLimits } from '../server/auth.ts';
import { blockWrites, postgresSkip, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip };
function response() {
  return { headers: {}, status: null, ended: false, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() { this.ended = true; } };
}
const count = async (db, table) => (await db.$client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count;
// Resolves after the first query whose SQL contains `marker` has returned, so a test can act at that exact point.
function afterQuery(db, marker) {
  let seen; const reached = new Promise(resolve => { seen = resolve; });
  const watched = new Proxy(db, { get(target, property) {
    if (property !== 'execute') return Reflect.get(target, property);
    return async query => { const result = await target.execute(query); if (target.dialect.sqlToQuery(query).sql.includes(marker)) seen(); return result; };
  } });
  return { db: watched, reached };
}
async function seedUser(db, id, email, password) { await db.$client.query('INSERT INTO users VALUES ($1, $2, $3, $4)', [id, 'Fixture', email, password]); }

test('an old-password login already verifying cannot create a session after a password change', pg, async t => {
  const { db } = await testDatabase(t), oldPassword = 'old fixture password 2026', nextPassword = 'new fixture password 2026';
  const oldHash = await hashPassword(oldPassword), nextHash = await hashPassword(nextPassword);
  await seedUser(db, 'user-a', 'fixture@example.test', oldHash);
  const watched = afterQuery(db, 'FROM users u WHERE email'), config = { sessionSecret: 'auth-race-fixture-session-secret-32-characters', appUrl: 'https://campaign.example' }, auth = createAuth(watched.db, config);
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res = response();
  const pending = auth.login(req, res, { email: 'fixture@example.test', password: oldPassword });
  // login has read the old hash and yielded to asynchronous scrypt verification.
  await watched.reached; await db.$client.query('UPDATE users SET password = $1 WHERE id = $2', [nextHash, 'user-a']);
  await assert.rejects(pending, error => error.status === 401 && /password changed/i.test(error.message));
  assert.equal(res.headers['Set-Cookie'], undefined); assert.equal(await count(db, 'sessions'), 0);
  await assert.rejects(auth.login(req, response(), { email: 'fixture@example.test', password: oldPassword }), error => error.status === 401);
  const current = response(), user = await auth.login(req, current, { email: 'fixture@example.test', password: nextPassword });
  assert.equal(user.id, 'user-a'); assert.match(current.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Max-Age=604800; Secure/); assert.equal(await count(db, 'sessions'), 1);
});

test('a password change cannot replace credentials or recreate a session revoked during password verification', pg, async t => {
  const { db } = await testDatabase(t), oldPassword = 'existing fixture password 2026', oldHash = await hashPassword(oldPassword);
  await seedUser(db, 'user-a', 'fixture@example.test', oldHash);
  const watched = afterQuery(db, 'SELECT password FROM users WHERE id'), auth = createAuth(watched.db, { sessionSecret: 'auth-revocation-fixture-secret-32-characters', appUrl: 'https://campaign.example' }), signedIn = response();
  await auth.establish(signedIn, 'user-a');
  const req = { headers: { cookie: signedIn.headers['Set-Cookie'].split(';')[0] } }, res = response();
  const pending = auth.changePassword(req, res, 'user-a', oldPassword, 'replacement fixture password 2026');
  // The request has entered asynchronous verification when another signed-in device revokes it.
  await watched.reached; await db.$client.query('DELETE FROM sessions WHERE user_id = $1', ['user-a']);
  await assert.rejects(pending, error => error.status === 403 && /session ended/i.test(error.message));
  assert.equal((await db.$client.query('SELECT password FROM users WHERE id = $1', ['user-a'])).rows[0].password, oldHash);
  assert.equal(await count(db, 'sessions'), 0);
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('parallel attempts cannot exceed a rate limit', pg, async t => {
  const { db, pool } = await testDatabase(t), auth = createAuth(db, { sessionSecret: 'limit-fixture-session-secret-32-characters', appUrl: 'https://campaign.example' });
  await auth.limit('warm-up', 10);
  // Every attempt reads the bucket before any increment commits; only the single conditional upsert holds the line.
  const gate = await blockWrites(pool, 'login_limits');
  const attempts = Array.from({ length: 30 }, () => auth.limit('parallel', 10).then(() => 'allowed', error => error.status));
  await gate.waiting(1); await gate.release();
  const outcomes = await Promise.all(attempts);
  assert.equal(outcomes.filter(outcome => outcome === 'allowed').length, 10); assert.equal(outcomes.filter(outcome => outcome === 429).length, 20);
  assert.equal((await db.$client.query("SELECT count FROM login_limits WHERE key = 'parallel'")).rows[0].count, 10);
});

test('parallel sign-ins cannot exceed the per-client or per-account limits', pg, async t => {
  const { db, pool } = await testDatabase(t), config = { sessionSecret: 'sign-in-race-fixture-secret-32-characters', appUrl: 'https://campaign.example', trustedProxies: ['10.0.0.2'] }, auth = createAuth(db, config);
  await auth.limit('warm-up', 10);
  const attempt = (client, email) => auth.login({ headers: { 'x-forwarded-for': client }, socket: { remoteAddress: '10.0.0.2' } }, response(), { email, password: 'wrong password guess' }).then(() => 'allowed', error => error.status);
  // Every attempt reads its buckets before any increment commits; only the single conditional upserts hold the lines.
  const gate = await blockWrites(pool, 'login_limits');
  const oneClient = Array.from({ length: signInLimits.client + 10 }, (_, index) => attempt('203.0.113.7', `spread-${index}@example.test`));
  const oneAccount = Array.from({ length: signInLimits.account + 10 }, (_, index) => attempt(`192.0.2.${index}`, 'member@example.test'));
  await gate.waiting(1); await gate.release();
  const tally = outcomes => [outcomes.filter(outcome => outcome === 401).length, outcomes.filter(outcome => outcome === 429).length];
  assert.deepEqual(tally(await Promise.all(oneClient)), [signInLimits.client, 10]); assert.deepEqual(tally(await Promise.all(oneAccount)), [signInLimits.account, 10]);
  const counter = async key => (await db.$client.query('SELECT count FROM login_limits WHERE key = $1', [key])).rows[0].count;
  assert.equal(await counter('ip:203.0.113.7'), signInLimits.client);
  assert.equal(await counter('email:' + createHmac('sha256', config.sessionSecret).update('member@example.test').digest('hex')), signInLimits.account);
});

function oidcFixture(t, db, config) {
  const issuer = config.oidcIssuer; let sequence = 0;
  const fixture = { exchanges: 0, claims: { iss: issuer, sub: 'existing-subject', email: 'identity@example.test', email_verified: true } };
  // Only the official client boundary is stubbed: no IdP or network is involved.
  const client = {
    async discovery(url, clientId) { assert.equal(url.href, issuer + '/'); assert.equal(clientId, 'fixture-client'); return { fixture: true }; },
    randomState() { return 'state-' + ++sequence; }, randomNonce() { return 'nonce-' + sequence; }, randomPKCECodeVerifier() { return 'verifier-' + sequence; },
    async calculatePKCECodeChallenge(verifier) { return 'challenge-' + verifier; },
    buildAuthorizationUrl(provider, params) { assert.equal(provider.fixture, true); assert.equal(params.redirect_uri, config.appUrl + '/api/auth/oidc/callback'); const url = new URL(issuer + '/authorize'); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value); return url; },
    async authorizationCodeGrant(provider, url, checks) { fixture.exchanges++; assert.equal(provider.fixture, true); assert.equal(checks.expectedState, url.searchParams.get('state')); assert.match(checks.pkceCodeVerifier, /^verifier-/); assert.match(checks.expectedNonce, /^nonce-/); assert.equal(checks.idTokenExpected, true); return { claims: () => fixture.claims }; },
  };
  const auth = createAuth(db, config, { openidClient: async () => client });
  fixture.auth = auth;
  fixture.start = async (query = '') => {
    const res = response(); await auth.oidcStart({ url: '/api/auth/oidc/start' + query, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    assert.equal(res.status, 302); const authorize = new URL(res.headers.Location), set = [].concat(res.headers['Set-Cookie']);
    const browser = set.find(value => value.startsWith('ten98_oidc_') && !value.startsWith('ten98_oidc_invite_')), invite = set.find(value => value.startsWith('ten98_oidc_invite_'));
    return { state: authorize.searchParams.get('state'), cookie: browser.split(';')[0], inviteCookie: invite, authorize };
  };
  fixture.callback = async (flow, query = '', cookie = [flow.cookie, flow.inviteCookie?.split(';')[0]].filter(Boolean).join('; ')) => {
    const res = response(), url = new URL(config.appUrl + '/api/auth/oidc/callback?state=' + encodeURIComponent(flow.state) + '&code=fixture-code' + query);
    await auth.oidcCallback({ headers: { cookie } }, res, url); return res;
  };
  return fixture;
}
const oidcConfig = (secret) => ({ appUrl: 'https://campaign.example', sessionSecret: secret, oidcEnabled: true, oidcIssuer: 'https://identity.example', oidcClientId: 'fixture-client', oidcAllowedEmails: ['allowed@example.test', 'local@example.test', 'parallel@example.test'] });

test('OIDC invitation continuation is browser-bound, single-use and origin-fixed without bypassing provisioning or identity linking', pg, async t => {
  const { db } = await testDatabase(t), config = oidcConfig('oidc-continuation-fixture-secret-32-characters'), invite = 'A'.repeat(43), appUrl = config.appUrl;
  await seedUser(db, 'local-user', 'local@example.test', 'unchanged-local-hash');
  await db.$client.query("INSERT INTO users VALUES ('identity-user', 'Identity', 'identity@example.test', NULL)");
  await db.$client.query('INSERT INTO oidc_identities VALUES ($1, $2, $3)', [config.oidcIssuer, 'existing-subject', 'identity-user']);
  const oidc = oidcFixture(t, db, config), digest = value => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  for (const value of ['https://attacker.example/redirect', '../escape', 'short']) await assert.rejects(oidc.start('?invite=' + encodeURIComponent(value)), error => error.status === 400);
  assert.equal(await count(db, 'oidc_flows'), 0);
  const flow = await oidc.start('?invite=' + invite + '&returnTo=https%3A%2F%2Fattacker.example');
  assert.match(flow.inviteCookie, new RegExp(`^ten98_oidc_invite_[0-9a-f]{16}=\\d+\\.${invite}; Path=/api/auth/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure$`));
  // #27: the database holds only a keyed hash of the continuation; no text column contains the raw token.
  const row = (await db.$client.query('SELECT * FROM oidc_return_targets')).rows[0];
  assert.equal(row.state, digest(flow.state)); assert.equal(row.invite_hash, digest(flow.inviteCookie.split(';')[0].split('=')[1]));
  for (const table of ['oidc_return_targets', 'oidc_flows']) for (const stored of (await db.$client.query(`SELECT * FROM ${table}`)).rows) for (const value of Object.values(stored)) assert.ok(!String(value).includes(invite), `${table} stores the raw invitation token`);
  await assert.rejects(oidc.callback({ ...flow, cookie: 'ten98_oidc=wrong-browser' }), error => error.status === 400); assert.equal(oidc.exchanges, 0); assert.equal(await count(db, 'oidc_return_targets'), 1);
  const accepted = await oidc.callback(flow, '&invite=' + 'B'.repeat(43) + '&returnTo=https%3A%2F%2Fattacker.example');
  assert.equal(accepted.status, 302); assert.equal(accepted.headers.Location, appUrl + '/?invite=' + invite); assert.equal(accepted.ended, true); assert.equal(oidc.exchanges, 1);
  assert.ok([].concat(accepted.headers['Set-Cookie']).some(value => /^ten98_oidc_invite_[0-9a-f]{16}=; Path=\/api\/auth\/oidc\/callback;.*Max-Age=0/.test(value)), 'the continuation cookie is cleared');
  assert.equal(await count(db, 'oidc_flows'), 0); assert.equal(await count(db, 'oidc_return_targets'), 0);
  await assert.rejects(oidc.callback(flow), error => error.status === 400); assert.equal(oidc.exchanges, 1);
  const noInvite = await oidc.start('?returnTo=https%3A%2F%2Fattacker.example');
  assert.equal((await oidc.callback(noInvite, '&invite=' + invite)).headers.Location, appUrl + '/');
  const tampered = await oidc.start('?invite=' + invite), [name, value] = tampered.inviteCookie.split(';')[0].split('=');
  assert.equal((await oidc.callback(tampered, '', `${tampered.cookie}; ${name}=${value.replace(invite, 'C'.repeat(43))}`)).headers.Location, appUrl + '/');
  const withoutCookie = await oidc.start('?invite=' + invite);
  assert.equal((await oidc.callback(withoutCookie, '', withoutCookie.cookie)).headers.Location, appUrl + '/');
  // An expired continuation yields no invitation even when its hash matches the stored row.
  const stale = await oidc.start('?invite=' + invite), staleValue = `${Date.now() - 1000}.${invite}`;
  await db.$client.query('UPDATE oidc_return_targets SET invite_hash = $1 WHERE state = $2', [digest(staleValue), digest(stale.state)]);
  assert.equal((await oidc.callback(stale, '', `${stale.cookie}; ${name}=${staleValue}`)).headers.Location, appUrl + '/');
  const expired = await oidc.start('?invite=' + invite); await db.$client.query('UPDATE oidc_flows SET expires_at = 0 WHERE state = $1', [digest(expired.state)]);
  const beforeExpiry = oidc.exchanges; await assert.rejects(oidc.callback(expired), error => error.status === 400); assert.equal(oidc.exchanges, beforeExpiry);
  const denied = await oidc.start('?invite=' + invite); oidc.claims = { iss: config.oidcIssuer, sub: 'new-unprovisioned-subject', email: 'outside@example.test', email_verified: true };
  await assert.rejects(oidc.callback(denied), error => error.status === 403); assert.equal((await db.$client.query("SELECT * FROM users WHERE email = 'outside@example.test'")).rowCount, 0);
  assert.equal((await db.$client.query('SELECT * FROM oidc_return_targets WHERE state = $1', [digest(denied.state)])).rowCount, 0);
  const linking = await oidc.start('?invite=' + invite); oidc.claims = { iss: config.oidcIssuer, sub: 'unlinked-subject', email: 'local@example.test', email_verified: true };
  await assert.rejects(oidc.callback(linking), error => error.status === 403 && /linking is disabled/.test(error.message));
  assert.equal((await db.$client.query("SELECT password FROM users WHERE id = 'local-user'")).rows[0].password, 'unchanged-local-hash');
  assert.equal((await db.$client.query("SELECT * FROM oidc_identities WHERE subject = 'unlinked-subject'")).rowCount, 0);
});

test('a replayed OIDC callback is claimed once even when the replays arrive together', pg, async t => {
  const { db, pool } = await testDatabase(t), config = oidcConfig('oidc-replay-fixture-secret-32-characters-x');
  await db.$client.query("INSERT INTO users VALUES ('identity-user', 'Identity', 'identity@example.test', NULL)");
  await db.$client.query('INSERT INTO oidc_identities VALUES ($1, $2, $3)', [config.oidcIssuer, 'existing-subject', 'identity-user']);
  const oidc = oidcFixture(t, db, config), flow = await oidc.start();
  // Both replays find the flow before either claim commits unless the claim itself is the single DELETE ... RETURNING.
  const gate = await blockWrites(pool, 'oidc_flows');
  const replays = [oidc.callback(flow), oidc.callback(flow)].map(attempt => attempt.then(res => res.status, error => error.status));
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(replays)).sort(), [302, 400]); assert.equal(oidc.exchanges, 1);
});

test('two first sign-ins for one new identity provision a single account', pg, async t => {
  const { db, pool } = await testDatabase(t), config = oidcConfig('oidc-provision-fixture-secret-32-characters');
  await seedUser(db, 'existing', 'someone@example.test', null);
  const oidc = oidcFixture(t, db, config); oidc.claims = { iss: config.oidcIssuer, sub: 'parallel-subject', email: 'parallel@example.test', email_verified: true };
  const flows = [await oidc.start(), await oidc.start()];
  // Without the identity lock both callbacks see no account and race to create one.
  const gate = await blockWrites(pool, 'users');
  const sign = flows.map(flow => oidc.callback(flow).then(res => res.status, error => error.status));
  // Two waiters: one blocked inserting the account, the other on the identity lock (or, without it, on its own insert).
  await gate.waiting(2); await gate.release();
  assert.deepEqual(await Promise.all(sign), [302, 302]);
  assert.equal((await db.$client.query("SELECT count(*) AS count FROM users WHERE email = 'parallel@example.test'")).rows[0].count, 1);
  assert.equal((await db.$client.query("SELECT count(*) AS count FROM oidc_identities WHERE subject = 'parallel-subject'")).rows[0].count, 1);
  assert.equal(await count(db, 'sessions'), 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, hashPassword, signInLimits } from '../server/auth.ts';
import { blockWrites, postgresSkip, signInRedirectError, testApp, testDatabase } from './postgres.mjs';

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
    const res = response(); await auth.oidcStart({ url: '/api/auth/oidc/start' + query, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res); signInRedirectError(res);
    assert.equal(res.status, 302); const authorize = new URL(res.headers.Location), set = [].concat(res.headers['Set-Cookie']);
    const browser = set.find(value => value.startsWith('ten98_oidc_') && !value.startsWith('ten98_oidc_invite_')), invite = set.find(value => value.startsWith('ten98_oidc_invite_'));
    return { state: authorize.searchParams.get('state'), cookie: browser.split(';')[0], inviteCookie: invite, authorize };
  };
  fixture.callback = async (flow, query = '', cookie = [flow.cookie, flow.inviteCookie?.split(';')[0]].filter(Boolean).join('; ')) => {
    const res = response(), url = new URL(config.appUrl + '/api/auth/oidc/callback?state=' + encodeURIComponent(flow.state) + '&code=fixture-code' + query);
    await auth.oidcCallback({ headers: { cookie } }, res, url); return signInRedirectError(res);
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
  await assert.rejects(oidc.callback(linking), error => error.code === 'OIDC_ACCOUNT_EXISTS');
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

// An owner's workspace with one project and one invitation; returns the raw invitation token.
async function seedInvitation(db, { token = 'I'.repeat(43), email = 'invitee@example.test', role = 'editor', expiresAt = Date.now() + 86400000, revokedAt = null } = {}) {
  await db.$client.query("INSERT INTO users VALUES ('inviter', 'Inviter', 'inviter@example.test', NULL) ON CONFLICT DO NOTHING");
  await db.$client.query("INSERT INTO workspaces (id, name) VALUES ('team', 'Team') ON CONFLICT DO NOTHING");
  await db.$client.query("INSERT INTO memberships VALUES ('team', 'inviter', 'owner') ON CONFLICT DO NOTHING");
  await db.$client.query("INSERT INTO projects (id, workspace_id, name) VALUES ('team-project', 'team', 'Team project') ON CONFLICT DO NOTHING");
  await db.$client.query('INSERT INTO workspace_invitations (id, workspace_id, email, role, inviter_id, token_hash, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', ['invitation-' + token.slice(0, 4), 'team', email, role, 'inviter', createHash('sha256').update(token).digest('hex'), Date.now(), expiresAt, revokedAt]);
  return token;
}
const memberships = async (db, email) => (await db.$client.query('SELECT m.workspace_id AS "workspaceId", m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 ORDER BY m.workspace_id', [email])).rows;
const accepted = async (db, token) => (await db.$client.query('SELECT accepted_at FROM workspace_invitations WHERE token_hash = $1', [createHash('sha256').update(token).digest('hex')])).rows[0].accepted_at;
const invitedIdentity = (config, email, extra = {}) => ({ iss: config.oidcIssuer, sub: 'invited-subject', email, email_verified: true, ...extra });

test('a verified invited email outside the OIDC allowlist joins only the inviting workspace', pg, async t => {
  const { db } = await testDatabase(t), config = oidcConfig('oidc-invite-fixture-secret-32-characters-a'), token = await seedInvitation(db);
  const oidc = oidcFixture(t, db, config); oidc.claims = invitedIdentity(config, 'Invitee@Example.test');
  const signedIn = await oidc.callback(await oidc.start('?invite=' + token));
  assert.equal(signedIn.status, 302); assert.equal(signedIn.headers.Location, config.appUrl + '/', 'the accepted invitation is not handed back to the browser');
  assert.deepEqual(await memberships(db, 'invitee@example.test'), [{ workspaceId: 'team', role: 'editor' }], 'membership only, no personal workspace');
  assert.equal(await count(db, 'workspaces'), 1); assert.equal(await count(db, 'projects'), 1);
  assert.ok(await accepted(db, token)); assert.equal(await count(db, 'sessions'), 1);
  assert.equal((await db.$client.query("SELECT password FROM users WHERE email = 'invitee@example.test'")).rows[0].password, null);
  // The invitation is single use: a second identity with the same email gets no account through it.
  oidc.claims = { ...invitedIdentity(config, 'invitee@example.test'), sub: 'second-subject' };
  await assert.rejects(oidc.callback(await oidc.start('?invite=' + token)), error => error.code === 'OIDC_NOT_PROVISIONED');
});

test('an invitation for another email or an unverified email does not provision an OIDC account', pg, async t => {
  const { db } = await testDatabase(t), config = oidcConfig('oidc-invite-fixture-secret-32-characters-b'), token = await seedInvitation(db), oidc = oidcFixture(t, db, config);
  // Allowlisted or not, a usable invitation names the address it was issued to.
  for (const email of ['someone@example.test', 'allowed@example.test']) {
    oidc.claims = invitedIdentity(config, email);
    await assert.rejects(oidc.callback(await oidc.start('?invite=' + token)), error => error.code === 'OIDC_INVITE_EMAIL_MISMATCH' && !error.location.includes('invitee') && error.location.includes('&invite='));
  }
  oidc.claims = invitedIdentity(config, 'invitee@example.test', { email_verified: false });
  await assert.rejects(oidc.callback(await oidc.start('?invite=' + token)), error => error.code === 'OIDC_EMAIL_UNVERIFIED');
  oidc.claims = invitedIdentity(config, 'invitee@example.test', { email_verified: 'true' });
  await assert.rejects(oidc.callback(await oidc.start('?invite=' + token)), error => error.status === 403);
  assert.equal(await count(db, 'users'), 1); assert.equal(await count(db, 'oidc_identities'), 0); assert.equal(await accepted(db, token), null);
});

test('an expired, revoked or no-longer-authorized invitation falls back to the OIDC allowlist', pg, async t => {
  const { db } = await testDatabase(t), config = oidcConfig('oidc-invite-fixture-secret-32-characters-c'), oidc = oidcFixture(t, db, config);
  const expired = await seedInvitation(db, { token: 'E'.repeat(43), expiresAt: Date.now() - 1000 }), revoked = await seedInvitation(db, { token: 'R'.repeat(43), revokedAt: Date.now() });
  const demoted = await seedInvitation(db, { token: 'D'.repeat(43), role: 'admin' });
  await db.$client.query("INSERT INTO users VALUES ('admin-inviter', 'Admin', 'admin@example.test', NULL)"); await db.$client.query("INSERT INTO memberships VALUES ('team', 'admin-inviter', 'admin')");
  await db.$client.query("UPDATE workspace_invitations SET inviter_id = 'admin-inviter' WHERE token_hash = $1", [createHash('sha256').update(demoted).digest('hex')]);
  oidc.claims = invitedIdentity(config, 'invitee@example.test');
  for (const token of [expired, revoked, demoted]) await assert.rejects(oidc.callback(await oidc.start('?invite=' + token)), error => error.code === 'OIDC_NOT_PROVISIONED', token[0]);
  assert.equal((await db.$client.query("SELECT * FROM users WHERE email = 'invitee@example.test'")).rowCount, 0);
  // An allowlisted email still gets its own workspace and resumes the (now unusable) invitation in the browser as before.
  oidc.claims = invitedIdentity(config, 'allowed@example.test'); await db.$client.query("UPDATE workspace_invitations SET email = 'allowed@example.test'");
  const fallback = await oidc.callback(await oidc.start('?invite=' + expired));
  assert.equal(fallback.headers.Location, config.appUrl + '/?invite=' + expired);
  assert.deepEqual((await memberships(db, 'allowed@example.test')).map(row => row.role), ['owner']); assert.equal(await accepted(db, expired), null);
});

test('two parallel OIDC callbacks for one invitation provision one account and one membership', pg, async t => {
  const { db, pool } = await testDatabase(t), config = oidcConfig('oidc-invite-fixture-secret-32-characters-d'), token = await seedInvitation(db);
  const oidc = oidcFixture(t, db, config); oidc.claims = invitedIdentity(config, 'invitee@example.test');
  const flows = [await oidc.start('?invite=' + token), await oidc.start('?invite=' + token)];
  // One callback blocks inserting the account while the other waits behind the workspace and invitation locks.
  const gate = await blockWrites(pool, 'users');
  const sign = flows.map(flow => oidc.callback(flow).then(res => res.status, error => error.status));
  await gate.waiting(2); await gate.release();
  assert.deepEqual(await Promise.all(sign), [302, 302]);
  assert.equal((await db.$client.query("SELECT count(*) AS count FROM users WHERE email = 'invitee@example.test'")).rows[0].count, 1);
  assert.deepEqual(await memberships(db, 'invitee@example.test'), [{ workspaceId: 'team', role: 'editor' }]);
  assert.equal(await count(db, 'workspaces'), 1); assert.ok(await accepted(db, token));
});

test('a member without a personal workspace loads the app state and the invited workspace projects', pg, async t => {
  const origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir: await mkdtemp(join(tmpdir(), 'ten98-oidc-invite-')), appUrl: origin });
  const db = app.database.db, config = { ...oidcConfig(app.config.sessionSecret), appUrl: origin }, token = await seedInvitation(db);
  const oidc = oidcFixture(t, db, config); oidc.claims = invitedIdentity(config, 'invitee@example.test');
  const signedIn = await oidc.callback(await oidc.start('?invite=' + token)), cookie = [].concat(signedIn.headers['Set-Cookie']).find(value => value.startsWith('ten98_session_')).split(';')[0];
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const get = async path => { const result = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { headers: { Cookie: cookie } }); return { status: result.status, data: await result.json() }; };
  const state = await get('/api/state');
  assert.equal(state.status, 200); assert.equal(state.data.user.email, 'invitee@example.test');
  assert.deepEqual(state.data.workspaces.map(({ id, role }) => ({ id, role })), [{ id: 'team', role: 'editor' }]);
  assert.deepEqual(state.data.projects.map(project => project.id), ['team-project']); assert.equal(state.data.projectId, 'team-project');
  assert.equal((await get('/api/state?projectId=team-project')).status, 200);
  assert.equal((await get('/api/projects/team-project/maps/config')).status, 200, 'project routes accept the invited member');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createAuth, hashPassword } from '../server/auth.ts';
import { postgresSkip, signInRedirectError, testDatabase } from './postgres.mjs';

test('same-host instances keep session and OIDC cookies isolated while safely migrating their own legacy cookies', { skip: postgresSkip }, async t => {
  const { db: dbA, sql: sqlA } = await testDatabase(t), { db: dbB, sql: sqlB } = await testDatabase(t);
  const secret = 'cookie fixture session secret of sufficient length', issuer = 'https://identity.example', password = 'cookie isolation fixture password', hash = await hashPassword(password);
  const config = appUrl => ({ appUrl, sessionSecret: secret, oidcEnabled: true, oidcIssuer: issuer, oidcClientId: appUrl, oidcAllowedEmails: [] });
  const configA = config('http://127.0.0.1:3018'), configB = config('http://127.0.0.1:3019'), digest = value => createHmac('sha256', secret).update(value).digest('hex');
  for (const [sql, id] of [[sqlA, 'alice'], [sqlB, 'bob']]) { await sql.run('INSERT INTO users VALUES(?,?,?,?)', id, id, id + '@example.test', hash); await sql.run('INSERT INTO oidc_identities VALUES(?,?,?)', issuer, 'existing-identity', id); }
  const jar = new Map(), request = () => ({ headers: { cookie: [...jar].map(([name, value]) => name + '=' + value).join('; ') }, socket: { remoteAddress: '127.0.0.1' } });
  function response() { return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} }; }
  const setCookies = res => { const value = res.headers['Set-Cookie']; return Array.isArray(value) ? value : value ? [value] : []; };
  function absorb(res) { for (const cookie of setCookies(res)) { const [pair] = cookie.split(';'), separator = pair.indexOf('='), name = pair.slice(0, separator), value = pair.slice(separator + 1); if (/Max-Age=0(?:;|$)/.test(cookie)) jar.delete(name); else jar.set(name, value); } }
  async function legacySession(sql, age = 120000) { const token = randomBytes(32).toString('base64url'); await sql.run('INSERT INTO sessions VALUES(?,?,?)', digest(token), sql === sqlA ? 'alice' : 'bob', Date.now() + age); return token; }
  const authA = createAuth(dbA, configA), authB = createAuth(dbB, configB), firstA = response(), firstB = response();
  await authA.establish(firstA, 'alice'); absorb(firstA); await authB.establish(firstB, 'bob'); absorb(firstB);
  const nameA = setCookies(firstA)[0].split('=')[0], nameB = setCookies(firstB)[0].split('=')[0];
  assert.notEqual(nameA, nameB); assert.match(nameA, /^ten98_session_[a-f0-9]{16}$/); assert.equal(jar.size, 2);
  assert.equal((await authA.user(request())).id, 'alice'); assert.equal((await authB.user(request())).id, 'bob');
  const extra = response(); await authA.establish(extra, 'alice'); assert.equal(await authA.revokeOtherSessions(request(), 'alice'), 1); assert.equal((await authA.user(request())).id, 'alice');
  const signout = response(); await authA.logout(request(), signout); absorb(signout);
  assert.equal(await authA.user(request()), null); assert.equal((await authB.user(request())).id, 'bob'); assert.equal(jar.has(nameB), true);

  const legacy = await legacySession(sqlA); jar.set('ten98_session', legacy);
  const foreignOnly = { headers: { cookie: 'ten98_session=' + legacy } }, foreignRes = response();
  assert.equal(await authB.user(foreignOnly, foreignRes), null); assert.deepEqual(setCookies(foreignRes), []);
  const migration = response(); assert.equal((await authA.user(request(), migration)).id, 'alice');
  const scopedMigration = setCookies(migration).find(cookie => cookie.startsWith(nameA + '='));
  assert.ok(scopedMigration); assert.ok(Number(/Max-Age=(\d+)/.exec(scopedMigration)[1]) <= 120, 'Migration must not extend the legacy session lifetime.');
  absorb(migration); assert.equal(jar.has('ten98_session'), false); assert.equal((await authA.user(request())).id, 'alice'); assert.equal((await authB.user(request())).id, 'bob');
  const downgradeLegacy = await legacySession(sqlA), badScoped = response();
  assert.equal(await authA.user({ headers: { cookie: `${nameA}=invalid; ten98_session=${downgradeLegacy}` } }, badScoped), null, 'An invalid scoped cookie must not fall back to another identity.');
  assert.deepEqual(setCookies(badScoped), []);
  jar.set('ten98_session', downgradeLegacy);
  const signedOut = response(); await authA.logout(request(), signedOut); absorb(signedOut);
  assert.equal(await authA.user(request()), null); assert.equal((await authB.user(request())).id, 'bob');
  assert.equal(await authA.user({ headers: { cookie: 'ten98_session=' + downgradeLegacy } }), null, 'Logout must revoke local legacy fallback tokens too.');
  const expired = await legacySession(sqlA, -1000), expiredRes = response(); assert.equal(await authA.user({ headers: { cookie: 'ten98_session=' + expired } }, expiredRes), null); assert.deepEqual(setCookies(expiredRes), []);

  const localLegacy = await legacySession(sqlA); jar.set('ten98_session', localLegacy);
  const login = response(); await authA.login(request(), login, { email: 'alice@example.test', password }); absorb(login);
  assert.equal(jar.has('ten98_session'), false); assert.equal(await authA.user({ headers: { cookie: 'ten98_session=' + localLegacy } }), null); assert.equal((await authA.user(request())).id, 'alice'); assert.equal((await authB.user(request())).id, 'bob');
  const foreignLegacy = await legacySession(sqlB); jar.set('ten98_session', foreignLegacy);
  const anotherLogin = response(); await authA.login(request(), anotherLogin, { email: 'alice@example.test', password }); absorb(anotherLogin);
  assert.equal(jar.get('ten98_session'), foreignLegacy, 'An app must not clear a legacy cookie validated only by another database.');

  let sequence = 0, exchanges = 0;
  const oidcClient = {
    async discovery(url, clientId) { return { clientId }; }, randomState() { return 'state-' + ++sequence; }, randomNonce() { return 'nonce-' + sequence; }, randomPKCECodeVerifier() { return 'verifier-' + sequence; }, async calculatePKCECodeChallenge(value) { return value; },
    buildAuthorizationUrl(provider, params) { assert.equal(params.redirect_uri, provider.clientId + '/api/auth/oidc/callback'); const target = new URL(issuer + '/authorize'); for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value); return target; },
    async authorizationCodeGrant(provider, url, checks) { exchanges++; assert.equal(checks.expectedState, url.searchParams.get('state')); assert.equal(checks.idTokenExpected, true); return { claims: () => ({ iss: issuer, sub: 'existing-identity' }) }; },
  };
  const oidcA = createAuth(dbA, configA, { openidClient: async () => oidcClient }), oidcB = createAuth(dbB, configB, { openidClient: async () => oidcClient });
  async function start(auth) { const res = response(); await auth.oidcStart({ ...request(), url: '/api/auth/oidc/start' }, res); absorb(res); return { state: new URL(res.headers.Location).searchParams.get('state'), cookieName: setCookies(res)[0].split('=')[0] }; }
  async function callback(auth, appUrl, state) { const res = response(); await auth.oidcCallback(request(), res, new URL(appUrl + '/api/auth/oidc/callback?state=' + encodeURIComponent(state) + '&code=fixture')); absorb(res); return signInRedirectError(res); }
  const flowA = await start(oidcA), flowB = await start(oidcB);
  assert.notEqual(flowA.cookieName, flowB.cookieName); assert.equal(jar.has(flowA.cookieName), true); assert.equal(jar.has(flowB.cookieName), true);
  assert.equal((await callback(oidcA, configA.appUrl, flowA.state)).status, 302); assert.equal(jar.has(flowB.cookieName), true);
  assert.equal((await callback(oidcB, configB.appUrl, flowB.state)).status, 302); assert.equal(exchanges, 2);
  assert.equal((await authA.user(request())).id, 'alice'); assert.equal((await authB.user(request())).id, 'bob');

  const legacyState = 'legacy-state', legacyBrowser = randomBytes(32).toString('base64url');
  await sqlA.run('INSERT INTO oidc_flows VALUES(?,?,?,?,?)', digest(legacyState), digest(legacyBrowser), 'legacy-verifier', 'legacy-nonce', Date.now() + 600000); jar.set('ten98_oidc', legacyBrowser);
  await assert.rejects(callback(oidcB, configB.appUrl, legacyState), error => error.status === 400);
  assert.equal(jar.get('ten98_oidc'), legacyBrowser); assert.equal((await callback(oidcA, configA.appUrl, legacyState)).status, 302); assert.equal(jar.has('ten98_oidc'), false); assert.equal(exchanges, 3);
  await assert.rejects(callback(oidcA, configA.appUrl, legacyState), error => error.status === 400);
});

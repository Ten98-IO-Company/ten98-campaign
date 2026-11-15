import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createAuth, hashPassword } from '../server/auth.ts';
import { postgresSkip, signInRedirectError, testDatabase } from './postgres.mjs';
import { addOidcIdentity, addUsers } from './fixtures/accounts.ts';

test('same-host instances keep session and OIDC cookies isolated, and an OIDC sign-in passes the same session checks', { skip: postgresSkip }, async t => {
  const { db: dbA, sql: sqlA } = await testDatabase(t), { db: dbB, sql: sqlB } = await testDatabase(t);
  const secret = 'cookie fixture session secret of sufficient length', issuer = 'https://identity.example', password = 'cookie isolation fixture password', hash = await hashPassword(password);
  const config = appUrl => ({ appUrl, sessionSecret: secret, authSecret: 'better-auth fixture secret of at least 32 characters', oidcEnabled: true, oidcIssuer: issuer, oidcClientId: appUrl, oidcAllowedEmails: [] });
  const configA = config('http://127.0.0.1:3018'), configB = config('http://127.0.0.1:3019'), digest = value => createHmac('sha256', secret).update(value).digest('hex');
  for (const [sql, id] of [[sqlA, 'alice'], [sqlB, 'bob']]) { await addUsers(sql, [{ id: id, name: id, email: id + '@example.test', password: hash }]); await addOidcIdentity(sql, issuer, 'existing-identity', id); }
  const jar = new Map(), request = () => ({ headers: { cookie: [...jar].map(([name, value]) => name + '=' + value).join('; ') }, socket: { remoteAddress: '127.0.0.1' } });
  function response() { return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} }; }
  const setCookies = res => { const value = res.headers['Set-Cookie']; return Array.isArray(value) ? value : value ? [value] : []; };
  function absorb(res) { for (const cookie of setCookies(res)) { const [pair] = cookie.split(';'), separator = pair.indexOf('='), name = pair.slice(0, separator), value = pair.slice(separator + 1); if (/Max-Age=0(?:;|$)/.test(cookie)) jar.delete(name); else jar.set(name, value); } }
  const authA = createAuth(dbA, configA), authB = createAuth(dbB, configB), signIn = async (auth, email) => { const res = response(); await auth.login(request(), res, { email, password }); absorb(res); return res; };
  const firstA = await signIn(authA, 'alice@example.test'), firstB = await signIn(authB, 'bob@example.test');
  const sessionCookie = res => setCookies(res).find(cookie => /\.session_token=/.test(cookie)), nameA = sessionCookie(firstA).split('=')[0], nameB = sessionCookie(firstB).split('=')[0];
  // Each installation names its session cookie from its own origin, and the cookie is HttpOnly and SameSite=Lax (Secure on https).
  assert.notEqual(nameA, nameB); assert.match(nameA, /^ten98-campaign-[a-f0-9]{16}\.session_token$/); assert.equal(jar.size, 2);
  assert.match(sessionCookie(firstA), /; HttpOnly; SameSite=Lax$/); assert.doesNotMatch(sessionCookie(firstA), /Secure/);
  assert.equal((await authA.user(request())).id, 'alice'); assert.equal((await authB.user(request())).id, 'bob');
  // Another installation's cookie is never accepted, under its own name or under this installation's.
  assert.equal(await authA.user({ headers: { cookie: `${nameB}=${jar.get(nameB)}` } }), null);
  assert.equal(await authA.user({ headers: { cookie: `${nameA}=${jar.get(nameB)}` } }), null, 'A cookie signed for another installation is refused.');
  assert.equal(await authA.user({ headers: { cookie: `${nameA}=invalid; ten98_session=${jar.get(nameA)}` } }), null, 'An invalid cookie must not fall back to another one.');
  const extra = response(); await authA.login(request(), extra, { email: 'alice@example.test', password }); absorb(extra);
  assert.equal(await authA.revokeOtherSessions(request(), 'alice'), 1); assert.equal((await authA.user(request())).id, 'alice');
  const signout = response(); await authA.logout(request(), signout); absorb(signout);
  assert.equal(await authA.user(request()), null); assert.equal((await authB.user(request())).id, 'bob'); assert.equal(jar.has(nameB), true);
  const again = response(); await authA.login(request(), again, { email: 'alice@example.test', password }); absorb(again);
  assert.equal((await authA.user(request())).id, 'alice'); assert.equal((await authB.user(request())).id, 'bob');
  // An unscoped pre-Better Auth cookie may belong to any instance on this host; this one can no longer validate it.
  const foreignLegacy = randomBytes(32).toString('base64url'); jar.set('ten98_session', foreignLegacy);
  const anotherLogin = response(); await authA.login(request(), anotherLogin, { email: 'alice@example.test', password }); absorb(anotherLogin);
  const signoutAgain = response(); await authA.logout(request(), signoutAgain); absorb(signoutAgain);
  assert.equal(jar.get('ten98_session'), foreignLegacy, 'An app must not clear a legacy cookie validated only by another database.');
  const relogin = response(); await authA.login(request(), relogin, { email: 'alice@example.test', password }); absorb(relogin);

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

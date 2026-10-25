import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';

// Self-service password recovery (#284), as Discover offers it: one-hour single-use links sent by the installation's
// transactional email, the same answer for every address, and a reset that ends the account's sessions.
const pg = { skip: postgresSkip }, emailEnv = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'test-cloudflare-token', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'accounts@example.com' };

async function fixture(t, env = emailEnv) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-recovery-')), origin = 'http://127.0.0.1:3000';
  const app = await testApp(t, { dataDir, env, appUrl: origin, directScheduler: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, originalFetch = globalThis.fetch, sent = [];
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'api.cloudflare.com'); assert.ok(url.pathname.endsWith('/email/sending/send'));
    const body = JSON.parse(options.body); sent.push(body);
    return Response.json({ success: true, result: { message_id: 'reset-' + sent.length, delivered: body.to, queued: [], permanent_bounces: [] } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  async function request(path, { method = 'GET', body, cookie } = {}) {
    const response = await originalFetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner', email: 'owner@example.test', password: 'original owner password' } });
  assert.equal(setup.status, 201);
  const delivered = async count => { for (let tick = 0; tick < 50 && sent.length < count; tick++) await new Promise(resolve => setTimeout(resolve, 20)); return sent; };
  return { app, request, sent, delivered, ownerCookie: setup.cookie };
}
const tokenOf = mail => /#password-reset=([\w-]{43})/.exec(mail.text)?.[1];

test('a reset link resets the password once, within the hour, and ends every session', pg, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/auth/password-reset-status')).data, { configured: true });
  assert.equal((await f.request('/api/session', { cookie: f.ownerCookie })).data.user?.email, 'owner@example.test');
  const asked = await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'Owner@Example.test' } });
  assert.deepEqual([asked.status, asked.data], [200, { ok: true }]);
  const [mail] = await f.delivered(1), token = tokenOf(mail);
  assert.deepEqual(mail.to, ['owner@example.test']); assert.match(mail.subject, /Reset your ten98 Campaign password/); assert.ok(token, mail.text);
  assert.equal((await f.app.sql.get('SELECT count(*)::int AS n FROM password_resets WHERE token_hash = ?', token)).n, 0, 'Only a keyed hash of the token is stored.');

  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: 'short' } })).status, 400, 'The password policy applies.');
  const reset = await f.request('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: 'a brand new owner password' } });
  assert.deepEqual([reset.status, reset.data], [200, { ok: true }]);
  assert.equal((await f.request('/api/session', { cookie: f.ownerCookie })).data.user, null, 'The reset ends existing sessions.');
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: 'owner@example.test', password: 'original owner password' } })).status, 401);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: 'owner@example.test', password: 'a brand new owner password' } })).status, 200);
  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: 'yet another owner password' } })).status, 400, 'A link works once.');

  await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } });
  const expiring = tokenOf((await f.delivered(2))[1]);
  await f.app.sql.run('UPDATE password_resets SET expires_at = ?', Date.now() - 1);
  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body: { token: expiring, newPassword: 'yet another owner password' } })).status, 400, 'An expired link is refused.');
});

test('every address gets the same answer, a newer link replaces the older one, and requests are limited', pg, async t => {
  const f = await fixture(t);
  const unknown = await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'nobody@example.test' } });
  assert.deepEqual([unknown.status, unknown.data], [200, { ok: true }]);
  await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } });
  await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } });
  const mails = await f.delivered(2);
  assert.deepEqual(mails.map(mail => mail.to[0]), ['owner@example.test', 'owner@example.test'], 'No mail goes to an address without an account.');
  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body: { token: tokenOf(mails[0]), newPassword: 'a brand new owner password' } })).status, 400, 'The newer link replaced the older one.');
  assert.equal((await f.app.sql.get('SELECT count(*)::int AS n FROM password_resets')).n, 1);
  assert.equal((await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } })).status, 200);
  assert.equal((await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } })).status, 429, 'Three requests per address per window.');
  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body: { token: 'not-a-token', newPassword: 'a brand new owner password' } })).status, 400);
});

test('without transactional email the request explains the alternative and sends nothing', pg, async t => {
  const f = await fixture(t, {});
  assert.deepEqual((await f.request('/api/auth/password-reset-status')).data, { configured: false });
  const asked = await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } });
  assert.equal(asked.status, 503); assert.match(asked.data.error, /Ask your administrator/);
  assert.equal(f.sent.length, 0); assert.equal((await f.app.sql.get('SELECT count(*)::int AS n FROM password_resets')).n, 0);
});

// Review follow-ups on #287: a password changed in settings retires an outstanding link, and a failed send is logged
// without the address or the token.
test('changing the password in settings retires an outstanding reset link', pg, async t => {
  const f = await fixture(t);
  await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } });
  const token = tokenOf((await f.delivered(1))[0]);
  const changed = await f.request('/api/account/password', { method: 'POST', body: { currentPassword: 'original owner password', newPassword: 'a password chosen in settings' }, cookie: f.ownerCookie });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await f.app.sql.get('SELECT count(*)::int AS n FROM password_resets')).n, 0);
  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: 'a brand new owner password' } })).status, 400);
});

test('a reset email that cannot be sent is logged without the address or the token', pg, async t => {
  const f = await fixture(t), logged = [], originalError = console.error, workingFetch = globalThis.fetch;
  globalThis.fetch = async (target, options) => new URL(target).hostname === 'api.cloudflare.com' ? Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 500 }) : workingFetch(target, options);
  console.error = (...args) => logged.push(args.map(String).join(' '));
  t.after(() => { console.error = originalError; });
  assert.equal((await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: 'owner@example.test' } })).status, 200);
  for (let tick = 0; tick < 50 && !logged.length; tick++) await new Promise(resolve => setTimeout(resolve, 20));
  console.error = originalError;
  assert.equal(logged.length, 1, logged.join('\n')); assert.match(logged[0], /^Password reset email was not sent:/);
  const { token_hash: stored } = await f.app.sql.get('SELECT token_hash FROM password_resets');
  assert.doesNotMatch(logged[0], /owner@example\.test/); assert.ok(!logged[0].includes(stored));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, hashPassword, signInLimits } from '../server/auth.ts';
import { clientLimitKey } from '@ten98/runtime';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { addUsers } from './fixtures/accounts.ts';

const pg = { skip: postgresSkip }, secret = 'sign-in-limit-fixture-secret-32-characters';
function response() {
  return { headers: {}, status: null, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} };
}
const request = (peer, forwarded) => ({ headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }, socket: { remoteAddress: peer } });

// Address parsing belongs to @ten98/runtime; these cases check which per-client bucket a failed sign-in charges.
test('sign-in limits charge the client a trusted proxy reports and otherwise the socket peer', pg, async t => {
  const { db } = await testDatabase(t), auth = createAuth(db, { sessionSecret: secret, appUrl: 'https://campaign.example', trustedProxies: '10.0.0.0/8, 2001:db8:ffff::/48' });
  // Keys come from clientLimitKey (ten98-code-system#76): HMAC of the resolved address, IPv6 per /56, and one dedicated
  // key for unresolved clients.
  const key = address => clientLimitKey('ip', address, secret);
  const cases = [
    ['198.51.100.50', '203.0.113.7', key('198.51.100.50')], // untrusted peer: the header is ignored
    ['::ffff:198.51.100.51', '203.0.113.7', key('198.51.100.51')], // IPv4-mapped peer keyed as IPv4
    ['10.0.0.2', '192.0.2.1, 203.0.113.7', key('203.0.113.7')], // trusted peer: right-most untrusted hop
    ['10.1.2.3', '192.0.2.200, 203.0.113.8, 2001:db8:ffff::5, 10.9.9.9', key('203.0.113.8')], // chain of trusted proxies
    ['::ffff:10.0.0.2', '2001:DB8::9', key('2001:db8::9')],
    ['2001:db8:1:ab::1', undefined, key('2001:db8:1:ab::1')], ['2001:db8:1:cd::2', undefined, key('2001:db8:1:ab::1')], // one IPv6 /56 is one client
    ['10.0.0.2', undefined, 'ip:unresolved'], ['10.0.0.2', '203.0.113.9, not-an-address', 'ip:unresolved'], // unresolved clients get their own key
    // runtime 0.10.0: entries a client puts left of its own hop are not read, so junk there no longer hides the client.
    ['10.0.0.2', 'unknown, not-an-address, 198.51.100.77', key('198.51.100.77')],
  ];
  for (const [peer, forwarded] of cases) await assert.rejects(auth.login(request(peer, forwarded), response(), { email: 'nobody@example.test', password: 'wrong password guess' }), error => error.status === 401);
  const { rows } = await db.$client.query("SELECT key FROM login_limits WHERE key LIKE 'ip:%' ORDER BY key");
  assert.deepEqual(rows.map(row => row.key).sort(), [...new Set(cases.map(([, , expected]) => expected))].sort());
  assert.equal(new Set(rows.map(row => row.key)).size, 8, 'Two IPv6 hosts in one /56 share a key.');
  assert.doesNotMatch(rows.map(row => row.key).join(' '), /198.51|203.0|2001:/, 'Stored keys never reveal an address.');
});

test('an invalid TRUSTED_PROXIES setting stops startup', () => {
  for (const value of ['proxy.example', '10.0.0.0/33', ['10.0.0.2', '2001:db8::/129']]) {
    assert.throws(() => createAuth(undefined, { sessionSecret: secret, appUrl: 'https://campaign.example', trustedProxies: value }), /TRUSTED_PROXIES must be/);
  }
});

test('failed sign-ins from one client behind a trusted proxy leave other clients able to sign in', pg, async t => {
  const { db } = await testDatabase(t), password = 'proxy fixture password 2026';
  await addUsers(db.$client, [{ id: 'member', name: 'Member', email: 'member@example.test', password: await hashPassword(password) }]);
  const auth = createAuth(db, { sessionSecret: secret, appUrl: 'https://campaign.example', trustedProxies: ['10.0.0.2'] }), viaProxy = client => request('10.0.0.2', client);
  for (let attempt = 0; attempt < signInLimits.client; attempt++) {
    await assert.rejects(auth.login(viaProxy('203.0.113.7'), response(), { email: `guess-${attempt}@example.test`, password: 'wrong password guess' }), error => error.status === 401);
  }
  await assert.rejects(auth.login(viaProxy('203.0.113.7'), response(), { email: 'member@example.test', password }), error => error.status === 429);
  const user = await auth.login(viaProxy('198.51.100.9'), response(), { email: 'member@example.test', password });
  assert.equal(user?.id, 'member', 'A different client behind the same proxy can still sign in.');

  // An untrusted peer cannot leave its own limit by varying X-Forwarded-For.
  for (let attempt = 0; attempt < signInLimits.client; attempt++) {
    await assert.rejects(auth.login(request('198.51.100.50', `192.0.2.${attempt}`), response(), { email: `other-${attempt}@example.test`, password: 'wrong password guess' }), error => error.status === 401);
  }
  await assert.rejects(auth.login(request('198.51.100.50', '192.0.2.200'), response(), { email: 'other-final@example.test', password: 'wrong password guess' }), error => error.status === 429);
});

test('the per-account sign-in limit trips across client addresses, and one client alone cannot reach it', pg, async t => {
  const { db } = await testDatabase(t), password = 'account fixture password 2026';
  await addUsers(db.$client, [{ id: 'member', name: 'Member', email: 'member@example.test', password: await hashPassword(password) }]);
  const auth = createAuth(db, { sessionSecret: secret, appUrl: 'https://campaign.example', trustedProxies: ['10.0.0.2'] }), viaProxy = client => request('10.0.0.2', client);
  const wrong = { email: 'Member@Example.test', password: 'wrong password guess' }, failed = async (client, status) => assert.rejects(auth.login(viaProxy(client), response(), wrong), error => error.status === status);
  // One client stops at its per-account limit; the account stays open to everyone else.
  for (let attempt = 0; attempt < signInLimits.clientAccount; attempt++) await failed('203.0.113.7', 401);
  await failed('203.0.113.7', 429);
  assert.equal((await auth.login(viaProxy('198.51.100.9'), response(), { email: 'member@example.test', password }))?.id, 'member');
  // The successful sign-in counted too; failures spread over many clients reach the account-wide limit, keyed on the lowercased email.
  for (let attempt = signInLimits.clientAccount + 1; attempt < signInLimits.account; attempt++) await failed(`192.0.2.${attempt}`, 401);
  await failed('192.0.2.250', 429);
  await assert.rejects(auth.login(viaProxy('198.51.100.10'), response(), { email: 'member@example.test', password }), error => error.status === 429);
  await assert.rejects(auth.login(viaProxy('198.51.100.10'), response(), { email: 'someone-else@example.test', password }), error => error.status === 401, 'other accounts are unaffected');
});

// clientLimitKey throws on an invalid scope, which would turn a rate-limited request into a 500. Every scope the
// server passes must be one it accepts.
test('every rate-limit scope the server uses is a valid clientLimitKey scope', async () => {
  const { readdir, readFile } = await import('node:fs/promises'), dir = new URL('../server/', import.meta.url), scopes = new Set();
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.ts'))) {
    for (const match of (await readFile(new URL(file, dir), 'utf8')).matchAll(/clientKey\(req, ([^)]+)\)/g)) for (const literal of match[1].matchAll(/'([^']*)'/g)) scopes.add(literal[1]);
  }
  assert.deepEqual([...scopes].sort(), ['invitation-get', 'invitation-post', 'ip', 'oidc', 'password-recovery-request', 'password-recovery-reset', 'setup']);
  for (const scope of scopes) assert.doesNotThrow(() => clientLimitKey(scope, '203.0.113.7', secret), scope);
});
